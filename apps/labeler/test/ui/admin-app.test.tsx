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
	getEvaluations: vi.fn(),
	getEvaluation: vi.fn(),
	getActivity: vi.fn(),
	assessmentAction: vi.fn(),
	setIssuance: vi.fn(),
	setTakedown: vi.fn(),
	startEvaluation: vi.fn(),
}));

vi.mock("../../src/admin/api.js", () => api);

beforeEach(() => {
	Object.defineProperty(Element.prototype, "scrollIntoView", {
		configurable: true,
		value: vi.fn(),
	});
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

		expect(await screen.findByText("Labeler administration")).toBeTruthy();
		expect(screen.getByText("Reviewer")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Assessments" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Takedowns" })).toBeNull();
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

		expect(await screen.findByText("at://did:plc:test/profile/review-current")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		fireEvent.click(screen.getByRole("tab", { name: "Error" }));
		expect(await screen.findByText("at://did:plc:test/profile/error-current")).toBeTruthy();
		await act(async () => {
			resolveStalePage?.({ items: [assessment("review-stale", "review")] });
			await stalePage;
		});

		await waitFor(() =>
			expect(screen.queryByText("at://did:plc:test/profile/review-stale")).toBeNull(),
		);
	});
});

function assessment(runKey: string, state: "review" | "error") {
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
