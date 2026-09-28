import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import {
	ApproverSessionError,
	clearApproverSessionCookies,
	createApproverApplicationSession,
	requireApproverApplicationSession,
} from "../src/approver-session/session.js";

const APPROVER_DID = "did:plc:approver";
const ORIGIN = "https://release.example.com";

function cookiePair(setCookieHeaders: readonly string[]): string {
	return setCookieHeaders.map((header) => header.split(";", 1)[0]).join("; ");
}

function csrfValue(setCookieHeaders: readonly string[]): string {
	const header = setCookieHeaders.find((value) => value.startsWith("__Host-emdash_approver_csrf="));
	if (!header) throw new Error("Missing approver CSRF cookie");
	return header.split(";", 1)[0]?.split("=", 2)[1] ?? "";
}

afterEach(async () => {
	await reset();
});

describe("approver application session", () => {
	it("creates realm-specific hashed cookies and validates CSRF", async () => {
		const created = await createApproverApplicationSession(
			env.APPROVER_DO,
			APPROVER_DID,
			1_800_000_000_000,
		);
		const headers = created.setCookieHeaders;
		expect(headers[0]).toContain("__Host-emdash_approver_session=");
		expect(headers[0]).toContain("HttpOnly");
		expect(headers[1]).toContain("__Host-emdash_approver_csrf=");
		expect(headers.join("\n")).not.toContain("emdash_publisher_session");

		const request = new Request(`${ORIGIN}/v1/approver/credentials`, {
			method: "POST",
			headers: {
				cookie: cookiePair(headers),
				origin: ORIGIN,
				"x-emdash-request": "1",
				"x-emdash-csrf": csrfValue(headers),
			},
		});
		await expect(
			requireApproverApplicationSession(request, env.APPROVER_DO, ORIGIN, {
				requireCsrf: true,
			}),
		).resolves.toMatchObject({ approverDid: APPROVER_DID, sessionEpoch: 1 });

		const rows = await runInDurableObject(
			env.APPROVER_DO.getByName(APPROVER_DID),
			(_instance, state) =>
				state.storage.sql
					.exec<{ token_hash: string; csrf_hash: string }>(
						"SELECT token_hash, csrf_hash FROM approver_sessions",
					)
					.one(),
		);
		expect(rows.token_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(rows.csrf_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(JSON.stringify(rows)).not.toContain(csrfValue(headers));
	});

	it("rejects missing, cross-realm, duplicate, and bad-CSRF cookies", async () => {
		const created = await createApproverApplicationSession(env.APPROVER_DO, APPROVER_DID);
		const validCookies = cookiePair(created.setCookieHeaders);
		const cases = [
			new Request(`${ORIGIN}/v1/approver/credentials`),
			new Request(`${ORIGIN}/v1/approver/credentials`, {
				headers: { cookie: "__Host-emdash_publisher_session=not-an-approver-cookie" },
			}),
			new Request(`${ORIGIN}/v1/approver/credentials`, {
				headers: { cookie: `${validCookies}; ${validCookies}` },
			}),
			new Request(`${ORIGIN}/v1/approver/credentials`, {
				method: "POST",
				headers: {
					cookie: validCookies,
					origin: ORIGIN,
					"x-emdash-request": "1",
					"x-emdash-csrf": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				},
			}),
		];

		for (const request of cases) {
			await expect(
				requireApproverApplicationSession(request, env.APPROVER_DO, ORIGIN, {
					requireCsrf: request.method === "POST",
				}),
			).rejects.toBeInstanceOf(ApproverSessionError);
		}
	});

	it("emits deletion cookies for only the approver realm", () => {
		const headers = clearApproverSessionCookies();
		expect(headers).toHaveLength(2);
		expect(headers.every((header) => header.includes("Max-Age=0"))).toBe(true);
		expect(headers.join("\n")).not.toContain("publisher");
	});
});
