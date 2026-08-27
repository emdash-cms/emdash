import { I18nProvider } from "@lingui/react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getApproval, listApproverCredentials } from "./api.js";
import { App } from "./App.js";
import { applyLocale, i18n } from "./i18n.js";

const PUBLISHER_DID = "did:web:publisher.example.com";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";

function success(data: unknown): Response {
	return Response.json({ data, requestId: "request-1" });
}

function renderApp(path: string) {
	history.replaceState(null, "", path);
	return render(
		<I18nProvider i18n={i18n}>
			<App />
		</I18nProvider>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	applyLocale("en");
});

describe("release-service web surfaces", () => {
	it("shows publisher identity login when no application session exists", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json(
					{
						error: { code: "PUBLISHER_SESSION_INVALID", message: "Publisher session is not valid" },
						requestId: "request-1",
					},
					{ status: 401 },
				),
			),
		);
		renderApp("/publisher");

		expect(await screen.findByRole("heading", { name: "Sign in as a publisher" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Continue with Atmosphere" })).toBeTruthy();
	});

	it("renders publisher authority, workloads, and intent state", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const path = new URL(
					input instanceof Request ? input.url : input.toString(),
					location.origin,
				).pathname;
				if (path === "/v1/publisher") {
					return success({
						publisher: {
							did: PUBLISHER_DID,
							delegation: {
								releaseNsid: "com.emdashcms.experimental.package.release",
								scope: "atproto repo:com.emdashcms.experimental.package.release?action=create",
								issuer: "https://authorization.example.com",
								pdsUrl: "https://pds.example.com",
								expiresAt: null,
								refreshBefore: null,
								status: "active",
								stateVersion: 1,
							},
						},
					});
				}
				if (path === "/v1/publisher/workloads") {
					return success({
						items: [
							{
								packageSlug: "gallery",
								repository: "example/gallery",
								repositoryId: "123",
								repositoryOwnerId: "456",
								workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
								allowedRefs: ["refs/heads/main"],
								allowedEnvironments: [],
								active: true,
								stateVersion: 1,
								authorizedBy: PUBLISHER_DID,
								createdAt: 1_799_999_000_000,
								updatedAt: 1_799_999_000_000,
							},
						],
					});
				}
				return success({
					items: [
						{
							id: INTENT_ID,
							publisherDid: PUBLISHER_DID,
							packageSlug: "gallery",
							version: "1.2.3",
							state: "awaiting_approval",
							stateGeneration: 4,
							reasonCode: "APPROVAL_REQUIRED",
							workflowId: INTENT_ID,
							expiresAt: 1_800_000_000_000,
							createdAt: 1_799_999_000_000,
							updatedAt: 1_799_999_500_000,
							result: null,
							approvalUrl: `${location.origin}/approvals/${INTENT_ID}?publisher=${encodeURIComponent(PUBLISHER_DID)}`,
						},
					],
				});
			}),
		);
		renderApp("/publisher");

		expect(await screen.findByText(PUBLISHER_DID)).toBeTruthy();
		expect(screen.getAllByText("gallery").length).toBeGreaterThan(0);
		expect(screen.getByText("Awaiting approval")).toBeTruthy();
	});

	it("shows immutable workload and provenance evidence before approval", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const path = new URL(
					input instanceof Request ? input.url : input.toString(),
					location.origin,
				).pathname;
				if (path === "/v1/approver/credentials") {
					return success({
						items: [
							{
								id: "credential",
								name: "Work laptop",
								transports: ["internal"],
								createdAt: 1_799_999_000_000,
								lastUsedAt: null,
								revokedAt: null,
							},
						],
					});
				}
				return success({
					intent: {
						id: INTENT_ID,
						packageSlug: "gallery",
						version: "1.2.3",
						state: "awaiting_approval",
						expiresAt: 1_800_000_000_000,
					},
					evidence: { profileCid: "bafyprofile" },
					evidenceDigest: "D".repeat(43),
					review: {
						source: {
							repository: "example/gallery",
							workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
							commitSha: "a".repeat(40),
							runId: "100",
							actor: "release-bot",
						},
						artifact: { url: "https://example.com/gallery.tgz", checksum: "sha256:artifact" },
						provenance: {
							url: "https://example.com/provenance.json",
							checksum: "sha256:provenance",
							predicateType: "https://slsa.dev/provenance/v1",
							sourceRepository: "https://github.com/example/gallery",
							builderId:
								"https://github.com/example/gallery/.github/workflows/release.yml@refs/heads/main",
						},
						accessDiff: {
							escalation: true,
							changes: [
								{
									kind: "operation-added",
									category: "network",
									operation: "request",
									path: ["network", "request"],
									escalation: true,
								},
							],
						},
					},
				});
			}),
		);
		await expect(listApproverCredentials()).resolves.toHaveLength(1);
		await expect(getApproval(PUBLISHER_DID, INTENT_ID)).resolves.toMatchObject({
			review: { source: { repository: "example/gallery" } },
		});
		renderApp(`/approvals/${INTENT_ID}?publisher=${encodeURIComponent(PUBLISHER_DID)}`);

		expect(await screen.findByText("example/gallery")).toBeTruthy();
		expect(screen.getByText("sha256:artifact")).toBeTruthy();
		expect(screen.getByText("sha256:provenance")).toBeTruthy();
		const approve = screen.getByRole("button", { name: "Approve release" });
		expect(approve).toBeInstanceOf(HTMLButtonElement);
		expect(approve.hasAttribute("disabled")).toBe(false);
	});

	it("renders the Access operator control surface", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				success({
					state: {
						mode: "active",
						epoch: 1,
						reasonCode: null,
						changedBy: "system:bootstrap",
						changedAt: 0,
					},
				}),
			),
		);
		renderApp("/admin");

		expect(await screen.findByRole("heading", { name: "Service control" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Pause admission" })).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Publisher lookup" })).toBeTruthy();
	});

	it("applies right-to-left document direction for Arabic", async () => {
		applyLocale("ar");
		expect(document.documentElement.dir).toBe("rtl");
		expect(document.documentElement.lang).toBe("ar");
	});
});
