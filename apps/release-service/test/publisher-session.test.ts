import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import {
	PublisherSessionError,
	clearOAuthRouteCookie,
	clearPublisherSessionCookies,
	createOAuthRouteCookie,
	createPublisherApplicationSession,
	readOAuthRouteCookie,
	requirePublisherApplicationSession,
} from "../src/publisher-session/session.js";

const DID = "did:plc:publisher" as const;
const ORIGIN = "https://release.example.com";

function cookiePair(setCookie: string): string {
	return setCookie.split(";", 1)[0] ?? "";
}

afterEach(async () => {
	await reset();
});

describe("publisher application sessions", () => {
	it("stores only token hashes and validates the HttpOnly session cookie", async () => {
		const created = await createPublisherApplicationSession(env.PUBLISHER_DO, DID);
		const [sessionCookie, csrfCookie] = created.setCookieHeaders;
		expect(sessionCookie).toContain("__Host-emdash_publisher_session=");
		expect(sessionCookie).toContain("Secure");
		expect(sessionCookie).toContain("HttpOnly");
		expect(sessionCookie).toContain("SameSite=Lax");
		expect(csrfCookie).toContain("__Host-emdash_publisher_csrf=");
		expect(csrfCookie).not.toContain("HttpOnly");

		const persisted = await runInDurableObject(
			env.PUBLISHER_DO.getByName(DID),
			(_instance, state) =>
				state.storage.sql
					.exec<{ token_hash: string; csrf_hash: string }>(
						"SELECT token_hash, csrf_hash FROM publisher_sessions",
					)
					.one(),
		);
		const rawCookies = created.setCookieHeaders.map(cookiePair).join("; ");
		expect(rawCookies).not.toContain(persisted.token_hash);
		expect(rawCookies).not.toContain(persisted.csrf_hash);

		const request = new Request(`${ORIGIN}/v1/publisher`, {
			headers: { cookie: rawCookies },
		});
		await expect(
			requirePublisherApplicationSession(request, env.PUBLISHER_DO, ORIGIN),
		).resolves.toMatchObject({ publisherDid: DID, sessionEpoch: 1 });
	});

	it("requires same-origin double-submit CSRF for state changes", async () => {
		const created = await createPublisherApplicationSession(env.PUBLISHER_DO, DID);
		const cookies = created.setCookieHeaders.map(cookiePair).join("; ");
		const csrf = cookiePair(created.setCookieHeaders[1]).split("=", 2)[1] ?? "";
		const valid = new Request(`${ORIGIN}/v1/publisher/delegation`, {
			method: "POST",
			headers: {
				cookie: cookies,
				origin: ORIGIN,
				"x-emdash-request": "1",
				"x-emdash-csrf": csrf,
			},
		});
		await expect(
			requirePublisherApplicationSession(valid, env.PUBLISHER_DO, ORIGIN, {
				requireCsrf: true,
			}),
		).resolves.toMatchObject({ publisherDid: DID });

		for (const headers of [
			{ origin: "https://evil.example", "x-emdash-request": "1", "x-emdash-csrf": csrf },
			{ origin: ORIGIN, "x-emdash-request": "1", "x-emdash-csrf": "A".repeat(43) },
		]) {
			const request = new Request(`${ORIGIN}/v1/publisher/delegation`, {
				method: "POST",
				headers: { cookie: cookies, ...headers },
			});
			await expect(
				requirePublisherApplicationSession(request, env.PUBLISHER_DO, ORIGIN, {
					requireCsrf: true,
				}),
			).rejects.toBeInstanceOf(PublisherSessionError);
		}
	});

	it("rejects duplicate or malformed session cookies", async () => {
		const created = await createPublisherApplicationSession(env.PUBLISHER_DO, DID);
		const pair = cookiePair(created.setCookieHeaders[0]);
		for (const cookie of [`${pair}; ${pair}`, "__Host-emdash_publisher_session=not-base64"]) {
			const request = new Request(`${ORIGIN}/v1/publisher`, { headers: { cookie } });
			await expect(
				requirePublisherApplicationSession(request, env.PUBLISHER_DO, ORIGIN),
			).rejects.toMatchObject({ code: "PUBLISHER_SESSION_INVALID" });
		}
	});

	it("emits deletion cookies with the same security attributes", () => {
		for (const cookie of clearPublisherSessionCookies()) {
			expect(cookie).toContain("Path=/");
			expect(cookie).toContain("Max-Age=0");
			expect(cookie).toContain("Secure");
		}
	});
});

describe("OAuth callback routing cookie", () => {
	it("round trips an exact state binding and rejects state substitution", () => {
		const now = 1_800_000_000_000;
		const setCookie = createOAuthRouteCookie(
			{
				purpose: "release_delegation",
				expectedDid: DID,
				redirectTarget: "/publisher/delegation",
				stateId: "abcdefghijklmnopqrstuvwx",
			},
			now,
		);
		const request = new Request(`${ORIGIN}/oauth/callback`, {
			headers: { cookie: cookiePair(setCookie) },
		});
		expect(readOAuthRouteCookie(request, "abcdefghijklmnopqrstuvwx", now + 1)).toEqual({
			purpose: "release_delegation",
			expectedDid: DID,
			redirectTarget: "/publisher/delegation",
			stateId: "abcdefghijklmnopqrstuvwx",
			expiresAt: now + 10 * 60_000,
		});
		expect(() => readOAuthRouteCookie(request, "zyxwvutsrqponmlkjihgfedc", now + 1)).toThrow(
			PublisherSessionError,
		);
		expect(() =>
			readOAuthRouteCookie(request, "abcdefghijklmnopqrstuvwx", now + 10 * 60_000 + 1),
		).toThrow(PublisherSessionError);
	});

	it("clears the routing cookie", () => {
		expect(clearOAuthRouteCookie()).toContain("Max-Age=0");
	});
});
