import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import { createApproverApplicationSession } from "../src/approver-session/session.js";
import { handleRequest } from "../src/index.js";
import { TEST_BINDINGS } from "./fixtures/oauth.js";

const ORIGIN = "https://release.example.com";
const APPROVER_DID = "did:plc:approver";
const CREDENTIAL_ID = "credential-one";

function bindings() {
	return {
		...TEST_BINDINGS,
		PUBLIC_ORIGIN: ORIGIN,
		OAUTH_REDIRECT_URIS: `[
			"${ORIGIN}/oauth/callback"
		]`,
	};
}

function cookieValue(header: string): string {
	return header.split(";", 1)[0] ?? "";
}

async function approverHeaders() {
	const session = await createApproverApplicationSession(env.APPROVER_DO, APPROVER_DID);
	const csrf = cookieValue(session.setCookieHeaders[1]).split("=", 2)[1] ?? "";
	return {
		cookie: session.setCookieHeaders.map(cookieValue).join("; "),
		origin: ORIGIN,
		"x-emdash-request": "1",
		"x-emdash-csrf": csrf,
	};
}

afterEach(async () => {
	await reset();
});

describe("approver credential routes", () => {
	it("keeps credential lists behind the approver session realm", async () => {
		const unauthorized = await handleRequest(
			new Request(`${ORIGIN}/v1/approver/credentials`),
			bindings(),
		);
		expect(unauthorized.status).toBe(401);
		await expect(unauthorized.json()).resolves.toMatchObject({
			error: { code: "APPROVER_SESSION_INVALID" },
		});

		const authorized = await handleRequest(
			new Request(`${ORIGIN}/v1/approver/credentials`, {
				headers: await approverHeaders(),
			}),
			bindings(),
		);
		expect(authorized.status).toBe(200);
		await expect(authorized.json()).resolves.toMatchObject({ data: { items: [] } });
	});

	it("creates required-UV enrolment options only with CSRF", async () => {
		const headers = await approverHeaders();
		const withoutCsrf = await handleRequest(
			new Request(`${ORIGIN}/v1/approver/credentials/options`, {
				method: "POST",
				headers: { "content-type": "application/json", cookie: headers.cookie },
				body: JSON.stringify({ name: "Laptop" }),
			}),
			bindings(),
		);
		expect(withoutCsrf.status).toBe(401);

		const response = await handleRequest(
			new Request(`${ORIGIN}/v1/approver/credentials/options`, {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify({ name: "Laptop" }),
			}),
			bindings(),
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			data: {
				authenticatorSelection: { userVerification: "required" },
				rp: { id: "release.example.com" },
			},
		});
	});

	it("lists safe credential data and revokes a path-bound credential", async () => {
		const headers = await approverHeaders();
		await env.APPROVER_DO.getByName(APPROVER_DID).enrolCredential(APPROVER_DID, {
			credentialId: CREDENTIAL_ID,
			publicKey: new Uint8Array([1, 2, 3]),
			algorithm: -7,
			counter: 0,
			transports: ["internal"],
			name: "Laptop",
		});
		const listed = await handleRequest(
			new Request(`${ORIGIN}/v1/approver/credentials?limit=1`, { headers }),
			bindings(),
		);
		const listBody = await listed.json();
		expect(listBody).toMatchObject({
			data: { items: [{ id: CREDENTIAL_ID, name: "Laptop" }], nextCursor: CREDENTIAL_ID },
		});
		expect(JSON.stringify(listBody)).not.toContain("publicKey");

		const revoked = await handleRequest(
			new Request(`${ORIGIN}/v1/approver/credentials/${CREDENTIAL_ID}`, {
				method: "DELETE",
				headers,
			}),
			bindings(),
		);
		expect(revoked.status).toBe(200);
		await expect(revoked.json()).resolves.toMatchObject({
			data: { id: CREDENTIAL_ID, revokedAt: expect.any(Number) },
		});

		const wrongMethod = await handleRequest(
			new Request(`${ORIGIN}/v1/approver/credentials/${CREDENTIAL_ID}`, {
				method: "POST",
				headers,
			}),
			bindings(),
		);
		expect(wrongMethod.status).toBe(405);
	});

	it("clamps list limits and rejects reserved or malformed credential paths", async () => {
		const headers = await approverHeaders();
		const clamped = await handleRequest(
			new Request(`${ORIGIN}/v1/approver/credentials?limit=999`, { headers }),
			bindings(),
		);
		expect(clamped.status).toBe(200);

		for (const path of [
			"/v1/approver/credentials/options",
			"/v1/approver/credentials/not%2Fa%2Fcredential",
		]) {
			const response = await handleRequest(
				new Request(`${ORIGIN}${path}`, { method: "DELETE", headers }),
				bindings(),
			);
			expect(response.status).toBe(path.endsWith("options") ? 405 : 404);
		}
	});
});
