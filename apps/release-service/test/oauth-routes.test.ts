import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfiguration } from "../src/config.js";
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
	let issuedScope = "atproto";
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
			issuedScope = body.get("scope") ?? issuedScope;
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
				scope: issuedScope,
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
		expect(setCookie).toContain("__Host-emdash_oauth_route=");
		expect(network.requests.some((request) => request.path === "/revoke")).toBe(true);
		await expect(env.PUBLISHER_DO.getByName(DID).getDelegation(DID)).resolves.toBeNull();
	});

	it("keeps approver identity state and cookies in the approver realm", async () => {
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
		expect(setCookie).not.toContain("__Host-emdash_publisher_session=");
		await expect(env.APPROVER_DO.getByName(DID).listCredentials(DID, null, 10)).resolves.toEqual(
			[],
		);
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

	it("completes delegation callback into the publisher custody shard", async () => {
		const network = oauthNetwork();
		vi.stubGlobal("fetch", network.fetch);
		const config = await configuration();
		const session = await createPublisherApplicationSession(env.PUBLISHER_DO, DID);
		const sessionCookies = session.setCookieHeaders.map(cookiePair);
		const csrf = cookiePair(session.setCookieHeaders[1]).split("=", 2)[1] ?? "";
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
		);

		expect(callback.status).toBe(303);
		expect(callback.headers.get("location")).toBe(`${ORIGIN}/publisher/delegation`);
		await expect(env.PUBLISHER_DO.getByName(DID).getDelegation(DID)).resolves.toMatchObject({
			status: "active",
			scope:
				"atproto repo:com.emdashcms.experimental.package.release?action=create blob:application/gzip blob:image/*",
		});
	});

	it("rejects callback state substitution and clears the routing cookie", async () => {
		const config = await configuration();
		const created = await createPublisherApplicationSession(env.PUBLISHER_DO, DID);
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
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
		errorLog.mockRestore();
	});
});
