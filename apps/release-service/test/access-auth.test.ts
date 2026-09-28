import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
	authenticateAccessRequest,
	validateAccessMutation,
	type AccessRole,
} from "../src/access/auth.js";
import { apiSuccess } from "../src/api/response.js";
import { handleRequest } from "../src/index.js";
import type { RouteDefinition } from "../src/routes.js";
import { TEST_ACCESS_AUDIENCES, TEST_BINDINGS } from "./fixtures/oauth.js";

const ACCESS_KEY_ID = "access-test-key";
const ACCESS_SUBJECT = "7335d417-61da-459d-899c-0a01c76a2f94";
const ACCESS_EMAIL = "operator@example.com";
const ACCESS_CONFIGURATION = {
	teamDomain: TEST_BINDINGS.ACCESS_TEAM_DOMAIN,
	audiences: TEST_ACCESS_AUDIENCES,
} as const;

let privateKey: CryptoKey;
let keyResolver: JWTVerifyGetKey;

interface TokenOptions {
	role?: AccessRole;
	audience?: string;
	issuer?: string;
	subject?: string;
	email?: string | null;
	type?: string;
	issuedAt?: number;
	notBefore?: number;
	expiresAt?: number;
	custom?: Record<string, unknown>;
}

beforeAll(async () => {
	const keys = await generateKeyPair("RS256", { extractable: true });
	privateKey = keys.privateKey;
	const publicJwk = await exportJWK(keys.publicKey);
	publicJwk.kid = ACCESS_KEY_ID;
	publicJwk.alg = "RS256";
	publicJwk.use = "sig";
	keyResolver = createLocalJWKSet({ keys: [publicJwk] });
});

async function createAccessToken(options: TokenOptions = {}): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const payload: Record<string, unknown> = {
		type: options.type ?? "app",
		...options.custom,
	};
	if (options.email !== null) payload["email"] = options.email ?? ACCESS_EMAIL;
	return new SignJWT(payload)
		.setProtectedHeader({ alg: "RS256", kid: ACCESS_KEY_ID, typ: "JWT" })
		.setIssuer(options.issuer ?? ACCESS_CONFIGURATION.teamDomain)
		.setAudience(options.audience ?? ACCESS_CONFIGURATION.audiences[options.role ?? "viewer"])
		.setSubject(options.subject ?? ACCESS_SUBJECT)
		.setIssuedAt(options.issuedAt ?? now)
		.setNotBefore(options.notBefore ?? now - 1)
		.setExpirationTime(options.expiresAt ?? now + 300)
		.sign(privateKey);
}

function authenticatedRequest(
	token: string,
	role: AccessRole = "viewer",
	init?: RequestInit,
): Request {
	const headers = new Headers(init?.headers);
	headers.set("cf-access-jwt-assertion", token);
	return new Request(`https://release.example.com/admin/api/${role}/test`, {
		...init,
		headers,
	});
}

describe("Cloudflare Access authentication", () => {
	it.each(["viewer", "reviewer", "admin"] as const)(
		"authenticates a human %s audience",
		async (role) => {
			const token = await createAccessToken({ role });

			await expect(
				authenticateAccessRequest(
					authenticatedRequest(token),
					role,
					ACCESS_CONFIGURATION,
					keyResolver,
				),
			).resolves.toEqual({
				realm: "access",
				identity: ACCESS_SUBJECT,
				email: ACCESS_EMAIL,
				role,
			});
		},
	);

	it("authenticates any configured application audience for a role", async () => {
		const secondAdminAudience = "d".repeat(64);
		const configuration = {
			...ACCESS_CONFIGURATION,
			audiences: {
				...ACCESS_CONFIGURATION.audiences,
				admin: [ACCESS_CONFIGURATION.audiences.admin, secondAdminAudience],
			},
		};
		const token = await createAccessToken({ audience: secondAdminAudience });

		await expect(
			authenticateAccessRequest(authenticatedRequest(token), "admin", configuration, keyResolver),
		).resolves.toMatchObject({ role: "admin" });
	});

	it("requires the Access assertion header and does not trust the browser cookie", async () => {
		const request = new Request("https://release.example.com/admin/api/viewer/test", {
			headers: { cookie: "CF_Authorization=unverified" },
		});

		await expect(
			authenticateAccessRequest(request, "viewer", ACCESS_CONFIGURATION, keyResolver),
		).rejects.toMatchObject({ code: "ACCESS_AUTH_REQUIRED", status: 401 });
	});

	it("uses route audiences rather than optional group claims", async () => {
		const viewerTokenClaimingAdmin = await createAccessToken({
			role: "viewer",
			custom: { groups: ["release-service-admin"] },
		});

		await expect(
			authenticateAccessRequest(
				authenticatedRequest(viewerTokenClaimingAdmin),
				"admin",
				ACCESS_CONFIGURATION,
				keyResolver,
			),
		).rejects.toMatchObject({ code: "ACCESS_AUTH_INVALID", status: 403 });
	});

	it.each([
		["wrong issuer", { issuer: "https://other.cloudflareaccess.com" }],
		["wrong audience", { audience: "d".repeat(64) }],
		["expired token", { expiresAt: 1 }],
		["future token", { notBefore: Math.floor(Date.now() / 1000) + 3600 }],
		["future issuance", { issuedAt: Math.floor(Date.now() / 1000) + 3600 }],
		["service token", { subject: "", email: null }],
		["missing email", { email: null }],
		["wrong token type", { type: "org" }],
	] satisfies ReadonlyArray<readonly [string, TokenOptions]>)(
		"rejects a %s",
		async (_name, options) => {
			const token = await createAccessToken(options);

			await expect(
				authenticateAccessRequest(
					authenticatedRequest(token),
					"viewer",
					ACCESS_CONFIGURATION,
					keyResolver,
				),
			).rejects.toMatchObject({ code: "ACCESS_AUTH_INVALID", status: 403 });
		},
	);

	it("rejects malformed assertions without exposing verifier errors", async () => {
		await expect(
			authenticateAccessRequest(
				authenticatedRequest("not-a-jwt"),
				"viewer",
				ACCESS_CONFIGURATION,
				keyResolver,
			),
		).rejects.toMatchObject({
			code: "ACCESS_AUTH_INVALID",
			message: "Access authorization failed",
		});
	});

	it("rejects oversized assertions before key resolution", async () => {
		await expect(
			authenticateAccessRequest(
				authenticatedRequest("a".repeat(16 * 1024 + 1)),
				"viewer",
				ACCESS_CONFIGURATION,
				keyResolver,
			),
		).rejects.toMatchObject({ code: "ACCESS_AUTH_INVALID", status: 403 });
	});
});

describe("Access route enforcement", () => {
	const getRoute: RouteDefinition = {
		method: "GET",
		path: "/admin/api/viewer/test",
		accessRole: "viewer",
		handler: (_request, requestId, _configuration, _params, actor) =>
			apiSuccess({ actor }, requestId),
	};
	const postRoute: RouteDefinition = {
		method: "POST",
		path: "/admin/api/admin/test",
		accessRole: "admin",
		handler: (_request, requestId, _configuration, _params, actor) =>
			apiSuccess({ actor }, requestId),
	};

	it("authenticates before dispatch and passes the Access actor", async () => {
		const token = await createAccessToken({ role: "viewer" });
		const response = await handleRequest(
			authenticatedRequest(token),
			TEST_BINDINGS,
			[getRoute],
			keyResolver,
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			data: {
				actor: {
					realm: "access",
					identity: ACCESS_SUBJECT,
					email: ACCESS_EMAIL,
					role: "viewer",
				},
			},
		});
	});

	it("uses the route declaration for roleless operator API paths", async () => {
		const token = await createAccessToken({ role: "viewer" });
		const route: RouteDefinition = {
			method: "GET",
			path: "/admin/api/status",
			accessRole: "viewer",
			handler: (_request, requestId, _configuration, _params, actor) =>
				apiSuccess({ actor }, requestId),
		};
		const response = await handleRequest(
			new Request("https://release.example.com/admin/api/status", {
				headers: { "cf-access-jwt-assertion": token },
			}),
			TEST_BINDINGS,
			[route],
			keyResolver,
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			data: { actor: { identity: ACCESS_SUBJECT, role: "viewer" } },
		});
	});

	it("fails closed when an operator route omits its Access role", async () => {
		const unguardedRoute: RouteDefinition = {
			method: "GET",
			path: "/admin/api/viewer/test",
			handler: () => apiSuccess({ reached: true }, "unguarded"),
		};
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const response = await handleRequest(
				new Request("https://release.example.com/admin/api/viewer/test"),
				TEST_BINDINGS,
				[unguardedRoute],
				keyResolver,
			);

			expect(response.status).toBe(500);
			expect(await response.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
		} finally {
			errorLog.mockRestore();
		}
	});

	it("fails closed when the declared role does not match the route family", async () => {
		const mismatchedRoute: RouteDefinition = {
			method: "GET",
			path: "/admin/api/admin/test",
			accessRole: "viewer",
			handler: () => apiSuccess({ reached: true }, "mismatched"),
		};
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const response = await handleRequest(
				new Request("https://release.example.com/admin/api/admin/test"),
				TEST_BINDINGS,
				[mismatchedRoute],
				keyResolver,
			);

			expect(response.status).toBe(500);
			expect(await response.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
		} finally {
			errorLog.mockRestore();
		}
	});

	it("requires origin, custom-header, and idempotency checks for mutations", async () => {
		const token = await createAccessToken({ role: "admin" });
		const missingCsrf = await handleRequest(
			authenticatedRequest(token, "admin", { method: "POST" }),
			TEST_BINDINGS,
			[postRoute],
			keyResolver,
		);
		expect(missingCsrf.status).toBe(403);
		expect(await missingCsrf.json()).toMatchObject({ error: { code: "CSRF_INVALID" } });

		const invalidIdempotency = await handleRequest(
			authenticatedRequest(token, "admin", {
				method: "POST",
				headers: {
					origin: TEST_BINDINGS.PUBLIC_ORIGIN,
					"x-emdash-request": "1",
					"idempotency-key": "short",
				},
			}),
			TEST_BINDINGS,
			[postRoute],
			keyResolver,
		);
		expect(invalidIdempotency.status).toBe(400);
		expect(await invalidIdempotency.json()).toMatchObject({
			error: { code: "IDEMPOTENCY_KEY_INVALID" },
		});

		const accepted = await handleRequest(
			authenticatedRequest(token, "admin", {
				method: "POST",
				headers: {
					origin: TEST_BINDINGS.PUBLIC_ORIGIN,
					"x-emdash-request": "1",
					"idempotency-key": "operator-request-0001",
				},
			}),
			TEST_BINDINGS,
			[postRoute],
			keyResolver,
		);
		expect(accepted.status).toBe(200);
	});
});

describe("Access mutation validation", () => {
	it("rejects a cross-origin request even with the custom header", () => {
		const request = new Request("https://release.example.com/admin/api/admin/test", {
			method: "POST",
			headers: {
				origin: "https://attacker.example",
				"x-emdash-request": "1",
				"idempotency-key": "operator-request-0001",
			},
		});

		expect(() => validateAccessMutation(request, TEST_BINDINGS.PUBLIC_ORIGIN)).toThrowError(
			expect.objectContaining({ code: "CSRF_INVALID" }),
		);
	});
});
