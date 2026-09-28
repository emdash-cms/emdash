import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfiguration } from "../src/config.js";
import { identityDirectoryShard } from "../src/directory/sharding.js";
import {
	handleApproverIdentityAuthorize,
	handleOAuthCallback,
	handlePublisherDelegationAuthorize,
	handlePublisherIdentityAuthorize,
} from "../src/oauth/routes.js";
import { createPublisherApplicationSession } from "../src/publisher-session/session.js";
import { TEST_BINDINGS } from "./fixtures/oauth.js";

const ORIGIN = "https://release.example.com";
const DID = "did:web:publisher.example.com" as const;

function cookiePair(setCookie: string): string {
	return setCookie.split(";", 1)[0] ?? "";
}

function oauthNetwork() {
	const requests: Array<{ path: string; body: URLSearchParams }> = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		if (url.hostname === "publisher.example.com" && url.pathname === "/.well-known/did.json") {
			return Response.json({
				id: DID,
				service: [
					{
						id: "#atproto_pds",
						type: "AtprotoPersonalDataServer",
						serviceEndpoint: "https://pds.example",
					},
				],
			});
		}
		if (
			url.hostname === "pds.example" &&
			url.pathname === "/.well-known/oauth-protected-resource"
		) {
			return Response.json({
				resource: "https://pds.example",
				authorization_servers: ["https://authorization.example"],
			});
		}
		if (
			url.hostname === "authorization.example" &&
			url.pathname === "/.well-known/oauth-authorization-server"
		) {
			return Response.json({
				issuer: "https://authorization.example",
				authorization_endpoint: "https://authorization.example/authorize",
				token_endpoint: "https://authorization.example/token",
				revocation_endpoint: "https://authorization.example/revoke",
				pushed_authorization_request_endpoint: "https://authorization.example/par",
				client_id_metadata_document_supported: true,
				dpop_signing_alg_values_supported: ["ES256"],
				response_types_supported: ["code"],
				authorization_response_iss_parameter_supported: true,
			});
		}
		if (url.hostname === "authorization.example" && url.pathname === "/par") {
			const body = new URLSearchParams();
			if (input instanceof Request) {
				for (const [key, value] of await input.clone().formData()) {
					if (typeof value === "string") body.append(key, value);
				}
			} else if (typeof init?.body === "string") {
				for (const [key, value] of new URLSearchParams(init.body)) body.append(key, value);
			}
			requests.push({ path: url.pathname, body });
			return Response.json({
				request_uri: "urn:ietf:params:oauth:request_uri:test",
				expires_in: 60,
			});
		}
		if (url.hostname === "authorization.example" && url.pathname === "/token") {
			return Response.json({
				access_token: "access-token",
				refresh_token: "refresh-token",
				token_type: "DPoP",
				sub: DID,
				scope: requests.at(-1)?.body.get("scope") ?? "atproto",
				expires_in: 3600,
			});
		}
		if (url.hostname === "authorization.example" && url.pathname === "/revoke") {
			requests.push({ path: url.pathname, body: new URLSearchParams() });
			return new Response(null, { status: 200 });
		}
		throw new Error(`Unexpected request: ${url.toString()}`);
	};
	return { fetch, requests };
}

async function configuration() {
	return loadConfiguration({
		...TEST_BINDINGS,
		PUBLIC_ORIGIN: ORIGIN,
		OAUTH_REDIRECT_URIS: `["${ORIGIN}/oauth/callback"]`,
	});
}

afterEach(async () => {
	vi.unstubAllGlobals();
	await reset();
});

describe("publisher OAuth routes", () => {
	it("returns an authorization URL envelope for SPA navigation", async () => {
		const network = oauthNetwork();
		vi.stubGlobal("fetch", network.fetch);
		const response = await handlePublisherIdentityAuthorize(
			new Request(`${ORIGIN}/v1/publisher/session/authorize`, {
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					origin: ORIGIN,
					"x-emdash-request": "1",
				},
				body: JSON.stringify({ identifier: DID, redirectTarget: "/publisher" }),
			}),
			"route-json",
			await configuration(),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			data: {
				authorizationUrl: expect.stringContaining("https://authorization.example/authorize"),
			},
		});
		expect(response.headers.get("set-cookie")).toContain("__Host-emdash_oauth_route=");
	});

	it("starts identity authorization and completes a bound callback into an app session", async () => {
		const network = oauthNetwork();
		vi.stubGlobal("fetch", network.fetch);
		const config = await configuration();
		const start = await handlePublisherIdentityAuthorize(
			new Request(`${ORIGIN}/v1/publisher/session/authorize`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: ORIGIN,
					"x-emdash-request": "1",
				},
				body: JSON.stringify({ identifier: DID, redirectTarget: "/publisher" }),
			}),
			"route-start",
			config,
		);
		expect(start.status).toBe(303);
		expect(start.headers.get("location")).toContain("https://authorization.example/authorize");
		const routeCookie = cookiePair(start.headers.get("set-cookie") ?? "");
		expect(routeCookie).toContain("__Host-emdash_oauth_route=");
		const par = network.requests.find((request) => request.path === "/par");
		expect(par?.body.get("scope")).toBe("atproto");
		const state = par?.body.get("state");
		expect(state).toBeTruthy();

		const callback = await handleOAuthCallback(
			new Request(
				`${ORIGIN}/oauth/callback?code=code-1&state=${encodeURIComponent(state ?? "")}&iss=${encodeURIComponent("https://authorization.example")}`,
				{ headers: { cookie: routeCookie } },
			),
			"route-callback",
			config,
		);
		expect(callback.status).toBe(303);
		expect(callback.headers.get("location")).toBe(`${ORIGIN}/publisher`);
		const setCookie = callback.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("__Host-emdash_publisher_session=");
		expect(setCookie).toContain("__Host-emdash_publisher_csrf=");
		expect(setCookie).toContain("__Host-emdash_approver_session=");
		expect(setCookie).toContain("__Host-emdash_approver_csrf=");
		expect(setCookie).toContain("__Host-emdash_oauth_route=");
		expect(network.requests.some((request) => request.path === "/revoke")).toBe(true);
		await expect(env.PUBLISHER_DO.getByName(DID).getDelegation(DID)).resolves.toBeNull();
		await expect(
			env.IDENTITY_DIRECTORY_DO.getByName(await identityDirectoryShard(DID)).list(
				"publisher",
				null,
				10,
			),
		).resolves.toEqual([expect.objectContaining({ did: DID, kind: "publisher" })]);
		await expect(
			env.IDENTITY_DIRECTORY_DO.getByName(await identityDirectoryShard(DID)).list(
				"approver",
				null,
				10,
			),
		).resolves.toEqual([expect.objectContaining({ did: DID, kind: "approver" })]);
	});

	it("fails the callback before issuing an app session when directory registration fails", async () => {
		const network = oauthNetwork();
		vi.stubGlobal("fetch", network.fetch);
		const config = await configuration();
		const start = await handlePublisherIdentityAuthorize(
			new Request(`${ORIGIN}/v1/publisher/session/authorize`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: ORIGIN,
					"x-emdash-request": "1",
				},
				body: JSON.stringify({ identifier: DID, redirectTarget: "/publisher" }),
			}),
			"route-start-directory-failure",
			config,
		);
		const routeCookie = cookiePair(start.headers.get("set-cookie") ?? "");
		const state =
			network.requests.find((request) => request.path === "/par")?.body.get("state") ?? "";

		const callback = await handleOAuthCallback(
			new Request(
				`${ORIGIN}/oauth/callback?code=code-1&state=${encodeURIComponent(state)}&iss=${encodeURIComponent("https://authorization.example")}`,
				{ headers: { cookie: routeCookie } },
			),
			"route-callback-directory-failure",
			config,
			{
				registerDirectoryIdentity: async () => {
					throw new Error("directory unavailable");
				},
			},
		);

		expect(callback.status).toBe(400);
		const setCookie = callback.headers.get("set-cookie") ?? "";
		expect(setCookie).not.toContain("__Host-emdash_publisher_session=");
		expect(setCookie).not.toContain("__Host-emdash_publisher_csrf=");
	});

	it("establishes both account sessions from approver identity", async () => {
		const network = oauthNetwork();
		vi.stubGlobal("fetch", network.fetch);
		const config = await configuration();
		const start = await handleApproverIdentityAuthorize(
			new Request(`${ORIGIN}/v1/approver/session/authorize`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: ORIGIN,
					"x-emdash-request": "1",
				},
				body: JSON.stringify({ identifier: DID, redirectTarget: "/approvals/intent-1" }),
			}),
			"approver-start",
			config,
		);
		expect(start.status).toBe(303);
		const routeCookie = cookiePair(start.headers.get("set-cookie") ?? "");
		const par = network.requests.find((request) => request.path === "/par");
		expect(par?.body.get("scope")).toBe("atproto");
		const state = par?.body.get("state") ?? "";

		const callback = await handleOAuthCallback(
			new Request(
				`${ORIGIN}/oauth/callback?code=code-1&state=${encodeURIComponent(state)}&iss=${encodeURIComponent("https://authorization.example")}`,
				{ headers: { cookie: routeCookie } },
			),
			"approver-callback",
			config,
		);
		expect(callback.status).toBe(303);
		expect(callback.headers.get("location")).toBe(`${ORIGIN}/approvals/intent-1`);
		const setCookie = callback.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("__Host-emdash_approver_session=");
		expect(setCookie).toContain("__Host-emdash_approver_csrf=");
		expect(setCookie).toContain("__Host-emdash_publisher_session=");
		expect(setCookie).toContain("__Host-emdash_publisher_csrf=");
		await expect(env.APPROVER_DO.getByName(DID).listCredentials(DID, null, 10)).resolves.toEqual(
			[],
		);
		await expect(
			env.IDENTITY_DIRECTORY_DO.getByName(await identityDirectoryShard(DID)).list(
				"approver",
				null,
				10,
			),
		).resolves.toEqual([expect.objectContaining({ did: DID, kind: "approver" })]);
		await expect(
			env.IDENTITY_DIRECTORY_DO.getByName(await identityDirectoryShard(DID)).list(
				"publisher",
				null,
				10,
			),
		).resolves.toEqual([expect.objectContaining({ did: DID, kind: "publisher" })]);
	});

	it("keeps attacker-triggerable publisher authorization state out of the publisher shard", async () => {
		const network = oauthNetwork();
		vi.stubGlobal("fetch", network.fetch);
		const config = await configuration();
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const response = await handlePublisherIdentityAuthorize(
				new Request(`${ORIGIN}/v1/publisher/session/authorize`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: ORIGIN,
						"x-emdash-request": "1",
					},
					body: JSON.stringify({ identifier: DID, redirectTarget: "/publisher" }),
				}),
				`publisher-state-${attempt}`,
				config,
			);
			expect(response.status).toBe(303);
		}

		await expect(
			runInDurableObject(env.PUBLISHER_DO.getByName(DID), (_instance, state) =>
				state.storage.sql
					.exec<{ count: number }>("SELECT COUNT(*) AS count FROM oauth_states")
					.one(),
			),
		).resolves.toEqual({ count: 0 });
	});

	it("cannot exhaust approver authorization by filling the approver shard", async () => {
		const network = oauthNetwork();
		vi.stubGlobal("fetch", network.fetch);
		const config = await configuration();
		for (let attempt = 0; attempt < 21; attempt += 1) {
			const response = await handleApproverIdentityAuthorize(
				new Request(`${ORIGIN}/v1/approver/session/authorize`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: ORIGIN,
						"x-emdash-request": "1",
					},
					body: JSON.stringify({ identifier: DID, redirectTarget: "/approvals/intent-1" }),
				}),
				`approver-state-${attempt}`,
				config,
			);
			expect(response.status).toBe(303);
		}

		await expect(
			runInDurableObject(env.APPROVER_DO.getByName(DID), (_instance, state) =>
				state.storage.sql
					.exec<{ count: number }>(
						"SELECT COUNT(*) AS count FROM identity_transactions WHERE completed_at IS NULL",
					)
					.one(),
			),
		).resolves.toEqual({ count: 0 });
	});

	it("requires same-origin authorization and rejects oversized bodies before resolution", async () => {
		const config = await configuration();
		for (const request of [
			new Request(`${ORIGIN}/v1/publisher/session/authorize`, {
				method: "POST",
				headers: { "content-type": "application/json", origin: "https://evil.example" },
				body: "{}",
			}),
			new Request(`${ORIGIN}/v1/publisher/session/authorize`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: ORIGIN,
					"x-emdash-request": "1",
				},
				body: JSON.stringify({ identifier: DID, redirectTarget: `/${"x".repeat(5000)}` }),
			}),
		]) {
			const response = await handlePublisherIdentityAuthorize(request, "invalid-start", config);
			expect([403, 413]).toContain(response.status);
		}
	});

	it("requires a publisher session and CSRF before starting delegation", async () => {
		const config = await configuration();
		const response = await handlePublisherDelegationAuthorize(
			new Request(`${ORIGIN}/v1/publisher/delegation/authorize`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ redirectTarget: "/publisher/delegation" }),
			}),
			"missing-session",
			config,
		);
		expect(response.status).toBe(401);
	});

	it("starts delegation only from an authenticated CSRF-bound publisher session", async () => {
		const network = oauthNetwork();
		vi.stubGlobal("fetch", network.fetch);
		const config = await configuration();
		const session = await createPublisherApplicationSession(env.PUBLISHER_DO, DID);
		const cookies = session.setCookieHeaders.map(cookiePair).join("; ");
		const csrf = cookiePair(session.setCookieHeaders[1]).split("=", 2)[1] ?? "";
		const response = await handlePublisherDelegationAuthorize(
			new Request(`${ORIGIN}/v1/publisher/delegation/authorize`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: cookies,
					origin: ORIGIN,
					"x-emdash-request": "1",
					"x-emdash-csrf": csrf,
				},
				body: JSON.stringify({ redirectTarget: "/publisher/delegation" }),
			}),
			"delegation-start",
			config,
		);
		expect(response.status).toBe(303);
		const par = network.requests.find((request) => request.path === "/par");
		expect(par?.body.get("scope")).toBe(
			"atproto repo:com.emdashcms.experimental.package.release?action=create blob:application/gzip blob:image/*",
		);
		expect(par?.body.get("scope")).not.toContain("transition:generic");
	});

	it("completes delegation callback after directory registration", async () => {
		const network = oauthNetwork();
		vi.stubGlobal("fetch", network.fetch);
		const config = await configuration();
		const session = await createPublisherApplicationSession(env.PUBLISHER_DO, DID);
		const sessionCookies = session.setCookieHeaders.map(cookiePair);
		const csrf = sessionCookies[1]?.split("=", 2)[1] ?? "";
		const start = await handlePublisherDelegationAuthorize(
			new Request(`${ORIGIN}/v1/publisher/delegation/authorize`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: sessionCookies.join("; "),
					origin: ORIGIN,
					"x-emdash-request": "1",
					"x-emdash-csrf": csrf,
				},
				body: JSON.stringify({ redirectTarget: "/publisher/delegation" }),
			}),
			"delegation-start-callback",
			config,
		);
		const routeCookie = cookiePair(start.headers.get("set-cookie") ?? "");
		const state = network.requests.find((request) => request.path === "/par")?.body.get("state");
		expect(state).toBeTruthy();

		const callback = await handleOAuthCallback(
			new Request(
				`${ORIGIN}/oauth/callback?code=delegation-code&state=${encodeURIComponent(state ?? "")}&iss=${encodeURIComponent("https://authorization.example")}`,
				{ headers: { cookie: [...sessionCookies, routeCookie].join("; ") } },
			),
			"delegation-callback",
			config,
			{ registerDirectoryIdentity: async () => ({ shard: "00", created: true }) },
		);

		expect(callback.status).toBe(303);
		expect(callback.headers.get("location")).toBe(`${ORIGIN}/publisher/delegation`);
		await expect(env.PUBLISHER_DO.getByName(DID).getDelegation(DID)).resolves.toMatchObject({
			status: "active",
			scope:
				"atproto repo:com.emdashcms.experimental.package.release?action=create blob:application/gzip blob:image/*",
		});
	});

	it("does not retain delegated authority when directory registration fails", async () => {
		const network = oauthNetwork();
		vi.stubGlobal("fetch", network.fetch);
		const config = await configuration();
		const session = await createPublisherApplicationSession(env.PUBLISHER_DO, DID);
		const sessionCookies = session.setCookieHeaders.map(cookiePair);
		const csrf = sessionCookies[1]?.split("=", 2)[1] ?? "";
		const start = await handlePublisherDelegationAuthorize(
			new Request(`${ORIGIN}/v1/publisher/delegation/authorize`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: sessionCookies.join("; "),
					origin: ORIGIN,
					"x-emdash-request": "1",
					"x-emdash-csrf": csrf,
				},
				body: JSON.stringify({ redirectTarget: "/publisher" }),
			}),
			"delegation-directory-start",
			config,
		);
		const routeCookie = cookiePair(start.headers.get("set-cookie") ?? "");
		const state =
			network.requests.find((request) => request.path === "/par")?.body.get("state") ?? "";

		const callback = await handleOAuthCallback(
			new Request(
				`${ORIGIN}/oauth/callback?code=code-1&state=${encodeURIComponent(state)}&iss=${encodeURIComponent("https://authorization.example")}`,
				{ headers: { cookie: [...sessionCookies, routeCookie].join("; ") } },
			),
			"delegation-directory-callback",
			config,
			{
				registerDirectoryIdentity: async () => {
					throw new Error("directory unavailable");
				},
			},
		);

		expect(callback.status).toBe(400);
		await expect(env.PUBLISHER_DO.getByName(DID).getDelegation(DID)).resolves.toBeNull();
	});

	it("rejects callback state substitution and clears the routing cookie", async () => {
		const config = await configuration();
		const created = await createPublisherApplicationSession(env.PUBLISHER_DO, DID);
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const response = await handleOAuthCallback(
				new Request(`${ORIGIN}/oauth/callback?state=unknown-state-value`, {
					headers: { cookie: created.setCookieHeaders.map(cookiePair).join("; ") },
				}),
				"bad-callback",
				config,
			);
			expect(response.status).toBe(400);
			expect(response.headers.get("set-cookie")).toContain("__Host-emdash_oauth_route=");
			expect(await response.text()).not.toContain("unknown-state-value");
			expect(errorLog).toHaveBeenCalledWith(
				expect.stringContaining('"event":"oauth_callback_error"'),
			);
			expect(errorLog).toHaveBeenCalledWith(
				expect.stringContaining('"code":"PUBLISHER_SESSION_INVALID"'),
			);
		} finally {
			errorLog.mockRestore();
		}
	});
});
