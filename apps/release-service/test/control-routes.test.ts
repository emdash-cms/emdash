import { reset } from "cloudflare:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AccessRole } from "../src/access/auth.js";
import { handleRequest } from "../src/index.js";
import { ROUTES } from "../src/routes.js";
import { TEST_ACCESS_AUDIENCES, TEST_BINDINGS } from "./fixtures/oauth.js";

const ACCESS_KEY_ID = "control-route-access-key";
const OPERATOR_SUBJECT = "7335d417-61da-459d-899c-0a01c76a2f94";
const DID = "did:plc:publisher";

let privateKey: CryptoKey;
let keyResolver: JWTVerifyGetKey;

beforeAll(async () => {
	const keys = await generateKeyPair("RS256", { extractable: true });
	privateKey = keys.privateKey;
	const publicJwk = await exportJWK(keys.publicKey);
	publicJwk.kid = ACCESS_KEY_ID;
	publicJwk.alg = "RS256";
	publicJwk.use = "sig";
	keyResolver = createLocalJWKSet({ keys: [publicJwk] });
});

afterEach(async () => {
	await reset();
});

async function accessToken(role: AccessRole): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({ type: "app", email: "operator@example.com" })
		.setProtectedHeader({ alg: "RS256", kid: ACCESS_KEY_ID, typ: "JWT" })
		.setIssuer(TEST_BINDINGS.ACCESS_TEAM_DOMAIN)
		.setAudience(TEST_ACCESS_AUDIENCES[role])
		.setSubject(OPERATOR_SUBJECT)
		.setIssuedAt(now)
		.setNotBefore(now - 1)
		.setExpirationTime(now + 300)
		.sign(privateKey);
}

async function operatorRequest(
	path: string,
	role: AccessRole,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("cf-access-jwt-assertion", await accessToken(role));
	if (init.method && init.method !== "GET") {
		headers.set("origin", TEST_BINDINGS.PUBLIC_ORIGIN);
		headers.set("x-emdash-request", "1");
		if (!headers.has("idempotency-key")) {
			headers.set("idempotency-key", "operator-request-0001");
		}
	}
	return handleRequest(
		new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}${path}`, { ...init, headers }),
		TEST_BINDINGS,
		ROUTES,
		keyResolver,
	);
}

describe("Access service-control routes", () => {
	it("returns service status only for the viewer audience", async () => {
		const response = await operatorRequest("/admin/api/viewer/status", "viewer");

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			data: { state: { mode: "active", epoch: 1 } },
		});

		const wrongAudience = await operatorRequest("/admin/api/admin/service-mode", "viewer", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "publication-paused", reasonCode: "MAINTENANCE" }),
		});
		expect(wrongAudience.status).toBe(403);
		expect(await wrongAudience.json()).toMatchObject({ error: { code: "ACCESS_AUTH_INVALID" } });
	});

	it("changes service mode and replays the normalized idempotent request", async () => {
		const request = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "publication-paused", reasonCode: "MAINTENANCE" }),
		};
		const first = await operatorRequest("/admin/api/admin/service-mode", "admin", request);
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({
			data: {
				state: { mode: "publication-paused", epoch: 2, reasonCode: "MAINTENANCE" },
				replayed: false,
			},
		});

		const replay = await operatorRequest("/admin/api/admin/service-mode", "admin", request);
		expect(replay.status).toBe(200);
		expect(await replay.json()).toMatchObject({ data: { replayed: true } });

		const conflict = await operatorRequest("/admin/api/admin/service-mode", "admin", {
			...request,
			body: JSON.stringify({ mode: "admission-paused", reasonCode: "MAINTENANCE" }),
		});
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({
			error: { code: "IDEMPOTENCY_CONFLICT" },
		});
	});

	it("sets and reads a publisher suspension without exposing operator email", async () => {
		const changed = await operatorRequest("/admin/api/admin/publisher-control", "admin", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				publisherDid: DID,
				status: "suspended",
				reasonCode: "SECURITY_REVIEW",
			}),
		});
		expect(changed.status).toBe(200);

		const read = await operatorRequest(
			`/admin/api/viewer/publisher-control?did=${encodeURIComponent(DID)}`,
			"viewer",
		);
		const text = await read.text();
		expect(read.status).toBe(200);
		expect(JSON.parse(text)).toMatchObject({
			data: {
				publisher: {
					publisherDid: DID,
					status: "suspended",
					reasonCode: "SECURITY_REVIEW",
					changedBy: OPERATOR_SUBJECT,
				},
			},
		});
		expect(text).not.toContain("operator@example.com");
	});

	it("paginates sanitized control audit events", async () => {
		await operatorRequest("/admin/api/admin/service-mode", "admin", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "admission-paused", reasonCode: "MAINTENANCE" }),
		});
		await operatorRequest("/admin/api/admin/publisher-control", "admin", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "operator-request-0002",
			},
			body: JSON.stringify({
				publisherDid: DID,
				status: "suspended",
				reasonCode: "SECURITY_REVIEW",
			}),
		});

		const first = await operatorRequest("/admin/api/viewer/audit?limit=1", "viewer");
		expect(await first.json()).toMatchObject({
			data: { items: [{ sequence: 1 }], nextCursor: "1" },
		});

		const second = await operatorRequest("/admin/api/viewer/audit?after=1&limit=1", "viewer");
		expect(await second.json()).toMatchObject({ data: { items: [{ sequence: 2 }] } });
	});

	it("rejects invalid control bodies and query parameters", async () => {
		const body = await operatorRequest("/admin/api/admin/service-mode", "admin", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "active", reasonCode: "STALE_REASON" }),
		});
		expect(body.status).toBe(400);
		expect(await body.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });

		const query = await operatorRequest("/admin/api/viewer/audit?unexpected=1", "viewer");
		expect(query.status).toBe(400);
	});
});
