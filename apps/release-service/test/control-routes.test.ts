import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AccessRole } from "../src/access/auth.js";
import { handleRequest } from "../src/index.js";
import { ROUTES } from "../src/routes.js";
import { TEST_ACCESS_AUDIENCES, TEST_BINDINGS } from "./fixtures/oauth.js";

const ACCESS_KEY_ID = "control-route-access-key";
const OPERATOR_SUBJECT = "7335d417-61da-459d-899c-0a01c76a2f94";
const DID = "did:plc:publisher";
const KEYRING_V2 =
	'{"current":2,"keys":[{"version":1,"key":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"},{"version":2,"key":"ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8"}]}';
const KEYRING_V2_RETIRED =
	'{"current":2,"keys":[{"version":2,"key":"ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8"}]}';

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
	bindings = TEST_BINDINGS,
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
		bindings,
		ROUTES,
		keyResolver,
	);
}

describe("Access service-control routes", () => {
	it("returns service status only for the viewer audience", async () => {
		const response = await operatorRequest("/admin/api/status", "viewer");

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			data: { state: { mode: "active", epoch: 1 } },
		});

		const wrongAudience = await operatorRequest("/admin/api/pause", "viewer", {
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
		const first = await operatorRequest("/admin/api/pause", "admin", request);
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({
			data: {
				state: { mode: "publication-paused", epoch: 2, reasonCode: "MAINTENANCE" },
				replayed: false,
			},
		});

		const replay = await operatorRequest("/admin/api/pause", "admin", request);
		expect(replay.status).toBe(200);
		expect(await replay.json()).toMatchObject({ data: { replayed: true } });

		const conflict = await operatorRequest("/admin/api/pause", "admin", {
			...request,
			body: JSON.stringify({ mode: "admission-paused", reasonCode: "MAINTENANCE" }),
		});
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({
			error: { code: "IDEMPOTENCY_CONFLICT" },
		});
	});

	it("activates and retires configured encryption keys through Access", async () => {
		const configuredV2 = { ...TEST_BINDINGS, ENCRYPTION_KEYRING: KEYRING_V2 };
		const retiredV1 = { ...TEST_BINDINGS, ENCRYPTION_KEYRING: KEYRING_V2_RETIRED };
		const initiallyNotReady = await handleRequest(
			new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}/ready`),
			configuredV2,
			ROUTES,
			keyResolver,
		);
		expect(initiallyNotReady.status).toBe(503);
		const initial = await operatorRequest("/admin/api/encryption/keys", "viewer", {}, configuredV2);
		await expect(initial.json()).resolves.toMatchObject({
			data: {
				configured: { activeVersion: 2, versions: [1, 2] },
				keys: [{ version: 1, status: "active" }],
			},
		});

		await operatorRequest(
			"/admin/api/pause",
			"admin",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "key-lifecycle-pause-0001",
				},
				body: JSON.stringify({ mode: "publication-paused", reasonCode: "KEY_ROTATION" }),
			},
			configuredV2,
		);
		const activated = await operatorRequest(
			"/admin/api/encryption/keys/activate",
			"admin",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "key-lifecycle-activate-0001",
				},
				body: JSON.stringify({ version: 2 }),
			},
			configuredV2,
		);
		expect(activated.status).toBe(200);
		await expect(activated.json()).resolves.toMatchObject({
			data: {
				key: { version: 2, status: "active", changedBy: OPERATOR_SUBJECT },
				replayed: false,
			},
		});
		const ready = await handleRequest(
			new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}/ready`),
			configuredV2,
			ROUTES,
			keyResolver,
		);
		expect(ready.status).toBe(200);
		await env.SERVICE_CONTROL_DO.getByName("global").recordEncryptionVerification({
			targetKeyVersion: 2,
			workflowId: "V".repeat(43),
			actorIdentity: "release-service",
			publishers: 0,
			approvers: 0,
			records: 0,
			rotated: 0,
			verifiedAt: Date.now(),
		});

		const retained = await operatorRequest(
			"/admin/api/encryption/keys/1/retire",
			"admin",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "key-lifecycle-retire-0001",
				},
				body: "{}",
			},
			configuredV2,
		);
		expect(retained.status).toBe(409);
		await expect(retained.json()).resolves.toMatchObject({
			error: { code: "ENCRYPTION_OPERATION_FAILED" },
		});

		const retired = await operatorRequest(
			"/admin/api/encryption/keys/1/retire",
			"admin",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "key-lifecycle-retire-0002",
				},
				body: "{}",
			},
			retiredV1,
		);
		expect(retired.status).toBe(200);
		await expect(retired.json()).resolves.toMatchObject({
			data: { key: { version: 1, status: "retired" }, replayed: false },
		});
	});

	it("sets and reads a publisher suspension without exposing operator email", async () => {
		const changed = await operatorRequest(
			`/admin/api/publishers/${encodeURIComponent(DID)}/suspend`,
			"admin",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					suspended: true,
					reasonCode: "SECURITY_REVIEW",
				}),
			},
		);
		expect(changed.status).toBe(200);

		const read = await operatorRequest(
			`/admin/api/publishers/${encodeURIComponent(DID)}`,
			"viewer",
		);
		const text = await read.text();
		expect(read.status).toBe(200);
		expect(JSON.parse(text)).toMatchObject({
			data: {
				publisher: {
					did: DID,
					control: {
						publisherDid: DID,
						status: "suspended",
						reasonCode: "SECURITY_REVIEW",
						changedBy: OPERATOR_SUBJECT,
					},
				},
			},
		});
		expect(text).not.toContain("operator@example.com");
	});

	it("paginates sanitized control audit events", async () => {
		await operatorRequest("/admin/api/pause", "admin", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "admission-paused", reasonCode: "MAINTENANCE" }),
		});
		await operatorRequest(`/admin/api/publishers/${encodeURIComponent(DID)}/suspend`, "admin", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "operator-request-0002",
			},
			body: JSON.stringify({
				suspended: true,
				reasonCode: "SECURITY_REVIEW",
			}),
		});

		const first = await operatorRequest("/admin/api/audit?limit=1", "viewer");
		expect(await first.json()).toMatchObject({
			data: { items: [{ sequence: 1 }], nextCursor: "1" },
		});

		const second = await operatorRequest("/admin/api/audit?after=1&limit=1", "viewer");
		expect(await second.json()).toMatchObject({ data: { items: [{ sequence: 2 }] } });
	});

	it("rejects invalid control bodies and query parameters", async () => {
		const body = await operatorRequest("/admin/api/pause", "admin", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "active", reasonCode: "STALE_REASON" }),
		});
		expect(body.status).toBe(400);
		expect(await body.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });

		const query = await operatorRequest("/admin/api/audit?unexpected=1", "viewer");
		expect(query.status).toBe(400);
	});

	it.each([
		["GET", "/admin/api/viewer/status", "viewer"],
		["GET", `/admin/api/viewer/publisher-control?did=${encodeURIComponent(DID)}`, "viewer"],
		["GET", "/admin/api/viewer/audit", "viewer"],
		["GET", "/admin/api/viewer/encryption/keys", "viewer"],
		["POST", "/admin/api/admin/service-mode", "admin"],
		["POST", "/admin/api/admin/publisher-control", "admin"],
		["POST", "/admin/api/admin/encryption/keys/activate", "admin"],
		["POST", "/admin/api/admin/encryption/verify", "admin"],
		["POST", "/admin/api/admin/encryption/keys/1/retire", "admin"],
	] as const)("does not expose the legacy %s %s operator route", async (method, path, role) => {
		const response = await operatorRequest(path, role, {
			method,
			headers: method === "POST" ? { "content-type": "application/json" } : undefined,
			body: method === "POST" ? "{}" : undefined,
		});

		expect(response.status).toBe(404);
	});
});
