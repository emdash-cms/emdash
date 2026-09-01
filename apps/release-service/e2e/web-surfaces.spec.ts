import { Buffer } from "node:buffer";

import { expect, test } from "@playwright/test";

import { addVirtualWebAuthnAuthenticator } from "../../../e2e/fixtures/virtual-authenticator.js";

const PUBLISHER_DID = "did:web:publisher.example.com";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const BASE_URL = "http://localhost:5185";
const WEB_IDEMPOTENCY_KEY = /^web-/;

function success(data: unknown) {
	return {
		status: 200,
		contentType: "application/json",
		body: JSON.stringify({ data, requestId: "pw" }),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

test("Access denies an unauthenticated operator API request", async ({ request }) => {
	const response = await request.get("/admin/api/status");
	expect(response.status()).toBe(401);
	expect(response.headers()["content-type"]).toContain("application/json");
	expect(await response.json()).toMatchObject({ error: { code: "ACCESS_AUTH_REQUIRED" } });
});

test("publisher login sends mutation fencing and remains RTL-safe on mobile", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	let authorizationRequest: { body: unknown; headers: Record<string, string> } | null = null;
	await page.route("**/v1/publisher**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path === "/v1/publisher/session/authorize" && request.method() === "POST") {
			authorizationRequest = {
				body: request.postDataJSON(),
				headers: await request.allHeaders(),
			};
			await route.fulfill(success({ authorizationUrl: `${BASE_URL}/oauth/mock` }));
			return;
		}
		await route.fulfill({
			status: 401,
			contentType: "application/json",
			body: JSON.stringify({
				error: { code: "PUBLISHER_SESSION_INVALID", message: "Publisher session is not valid" },
				requestId: "pw",
			}),
		});
	});

	await page.goto("/publisher?locale=ar");
	await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
	expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
		),
	).toBe(true);
	await page.getByLabel("Account handle").fill("publisher.example.com");
	await page.getByRole("button", { name: "Sign in with Atmosphere" }).click();
	await page.waitForURL("**/oauth/mock");

	expect(authorizationRequest).not.toBeNull();
	expect(authorizationRequest!.headers["x-emdash-request"]).toBe("1");
	expect(authorizationRequest!.headers["origin"]).toBe(BASE_URL);
	expect(authorizationRequest!.body).toEqual({
		identifier: "publisher.example.com",
		redirectTarget: "/publisher?locale=ar",
	});
});

test("account approves a connection requested by the permanent release workflow", async ({
	page,
}) => {
	await page.context().addCookies([
		{
			name: "__Host-emdash_publisher_csrf",
			value: "C".repeat(43),
			url: "https://localhost:5185",
			httpOnly: false,
			secure: true,
			sameSite: "Strict",
		},
	]);
	let confirmed = false;
	const connectionRequest = {
		id: "01JABCDEFGHJKMNPQRSTVWXYZ1",
		packageSlug: "gallery",
		state: "pending",
		claim: {
			repository: "example/gallery",
			repositoryId: "123",
			repositoryOwner: "example",
			repositoryOwnerId: "456",
			repositoryVisibility: "private",
			workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
			ref: "refs/tags/v1.2.3",
			environment: "production",
		},
		refScope: null,
		expiresAt: 1_900_000_000_000,
		createdAt: 1_800_000_000_000,
		confirmedAt: null,
	};
	await page.route("**/v1/**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path === "/v1/publisher") {
			await route.fulfill(
				success({
					publisher: {
						did: PUBLISHER_DID,
						handle: "publisher.example.com",
						delegation: {
							releaseNsid: "com.emdashcms.experimental.package.release",
							scope:
								"atproto repo:com.emdashcms.experimental.package.release?action=create blob:application/gzip blob:image/*",
							issuer: "https://authorization.example.com",
							pdsUrl: "https://pds.example.com",
							expiresAt: null,
							refreshBefore: null,
							status: "active",
							stateVersion: 1,
						},
					},
				}),
			);
			return;
		}
		if (path === "/v1/publisher/workflow-connections" && request.method() === "GET") {
			await route.fulfill(success({ items: confirmed ? [] : [connectionRequest] }));
			return;
		}
		if (
			path === "/v1/publisher/workloads" ||
			path === "/v1/publisher/intents" ||
			path === "/v1/publisher/audit" ||
			path === "/v1/approver/credentials"
		) {
			await route.fulfill(success({ items: [] }));
			return;
		}
		if (path.endsWith("/confirm")) {
			confirmed = true;
			await route.fulfill(
				success({
					request: {
						...connectionRequest,
						state: "confirmed",
						refScope: "version_tags",
						confirmedAt: 1_800_000_002_000,
					},
					policy: {
						packageSlug: "gallery",
						repository: "example/gallery",
						repositoryId: "123",
						repositoryOwnerId: "456",
						workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
						allowedRefs: ["refs/tags/*"],
						allowedEnvironments: ["production"],
						active: true,
						stateVersion: 1,
						authorizedBy: PUBLISHER_DID,
						createdAt: 1_800_000_002_000,
						updatedAt: 1_800_000_002_000,
					},
					replayed: false,
				}),
			);
			return;
		}
		await route.abort();
	});

	await page.goto(`/publisher?connection=${connectionRequest.id}`);
	await expect(page.getByText("Signed in as @publisher.example.com")).toBeVisible();
	await expect(page.getByText(PUBLISHER_DID)).toHaveCount(0);
	await expect(page.getByRole("heading", { name: "2. Run your release workflow" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Approve workflow for gallery" })).toBeVisible();
	await expect(page.getByText("example/gallery")).toBeVisible();
	await expect(page.getByText(".github/workflows/release.yml")).toBeVisible();
	await expect(page.getByText("v1.2.3")).toBeVisible();
	await expect(page.getByText("All version tags")).toBeVisible();
	await page.getByRole("button", { name: "Approve workflow" }).click();
	await expect(page.getByRole("button", { name: "Check for workflow requests" })).toBeVisible();
	expect(confirmed).toBe(true);
});

test("approver enrols and uses a user-verified virtual passkey", async ({ page }) => {
	const removeAuthenticator = await addVirtualWebAuthnAuthenticator(page);
	let credentialId: string | null = null;
	let decisionAssertion: unknown = null;
	let decisionHeaders: Record<string, string> | null = null;
	try {
		await page.route("**/v1/**", async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (url.pathname === "/v1/approver/credentials" && request.method() === "GET") {
				await route.fulfill(
					success({
						items: credentialId
							? [
									{
										id: credentialId,
										name: "Virtual key",
										transports: ["internal"],
										createdAt: Date.now(),
										lastUsedAt: null,
										revokedAt: null,
									},
								]
							: [],
					}),
				);
				return;
			}
			if (url.pathname === "/v1/approver/credentials/options") {
				await route.fulfill(
					success({
						challenge: "AQID",
						rp: { id: "localhost", name: "EmDash" },
						user: { id: "BAUG", name: "did:plc:approver", displayName: "Approver" },
						pubKeyCredParams: [{ type: "public-key", alg: -7 }],
						authenticatorSelection: {
							residentKey: "preferred",
							userVerification: "required",
						},
						attestation: "none",
					}),
				);
				return;
			}
			if (url.pathname === "/v1/approver/credentials" && request.method() === "POST") {
				const body: unknown = request.postDataJSON();
				if (
					body === null ||
					typeof body !== "object" ||
					Array.isArray(body) ||
					!("rawId" in body) ||
					typeof body.rawId !== "string"
				) {
					throw new Error("Passkey registration response is invalid");
				}
				credentialId = body.rawId;
				expect((await request.allHeaders())["x-emdash-request"]).toBe("1");
				await route.fulfill(success(null));
				return;
			}
			if (url.pathname.endsWith("/options")) {
				expect((await request.allHeaders())["x-emdash-request"]).toBe("1");
				await route.fulfill(
					success({
						challenge: "BwgJ",
						rpId: "localhost",
						userVerification: "required",
						allowCredentials: [{ type: "public-key", id: credentialId }],
					}),
				);
				return;
			}
			if (url.pathname === `/v1/approvals/${INTENT_ID}` && request.method() === "POST") {
				decisionAssertion = request.postDataJSON();
				decisionHeaders = await request.allHeaders();
				await route.fulfill(success(null));
				return;
			}
			if (url.pathname === `/v1/approvals/${INTENT_ID}`) {
				await route.fulfill(
					success({
						intent: {
							id: INTENT_ID,
							packageSlug: "gallery",
							version: "1.2.3",
							state: "awaiting_approval",
							expiresAt: Date.now() + 60_000,
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
							accessDiff: { escalation: false, changes: [] },
						},
					}),
				);
				return;
			}
			await route.abort();
		});

		await page.goto(`/approvals/${INTENT_ID}?publisher=${encodeURIComponent(PUBLISHER_DID)}`);
		await expect(page.getByRole("heading", { name: "Review plugin release" })).toBeVisible();
		await page.getByLabel("Passkey name").fill("Virtual key");
		await page.getByRole("button", { name: "Add passkey" }).click();
		await expect(page.getByText("Virtual key", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Approve release" }).click();
		await expect(
			page.getByText("Approval recorded. The release workflow can continue."),
		).toBeVisible();
		expect(decisionAssertion).toMatchObject({
			decision: "approve",
			response: { type: "public-key" },
		});
		expect(decisionHeaders?.["x-emdash-request"]).toBe("1");
		expect(decisionHeaders?.["idempotency-key"]).toMatch(WEB_IDEMPOTENCY_KEY);
		const credential = isRecord(decisionAssertion) ? decisionAssertion["response"] : null;
		const assertion = isRecord(credential) ? credential["response"] : null;
		if (!isRecord(assertion) || typeof assertion["authenticatorData"] !== "string") {
			throw new Error("Passkey assertion response is invalid");
		}
		const authenticatorData = Buffer.from(assertion["authenticatorData"], "base64url");
		expect(authenticatorData.byteLength).toBeGreaterThan(32);
		expect(authenticatorData[32]! & 0x04).toBe(0x04);
	} finally {
		await removeAuthenticator();
	}
});
