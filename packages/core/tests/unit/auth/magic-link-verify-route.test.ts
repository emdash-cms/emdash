/**
 * Regression tests for /_emdash/api/auth/magic-link/verify.
 *
 * GET must render a safe confirmation page without consuming the single-use
 * token. POST must verify the token, create a session, and redirect.
 */

import { Role, sendMagicLink } from "@emdash-cms/auth";
import type { AuthAdapter } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	GET as verifyGet,
	POST as verifyPost,
} from "../../../src/astro/routes/api/auth/magic-link/verify.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

interface SessionData {
	user?: { id: string };
}

function buildContext(opts: {
	db: Kysely<Database>;
	request: Request;
	sessionData?: SessionData;
}): APIContext {
	const url = new URL(opts.request.url);
	const session = {
		set: vi.fn((key: "user" | "hasSeenWelcome", value: { id: string } | boolean) => {
			if (opts.sessionData && key === "user" && typeof value === "object" && value !== null) {
				opts.sessionData.user = value as { id: string };
			}
		}),
		get: vi.fn(),
		regenerate: vi.fn(),
	};
	return {
		request: opts.request,
		url,
		locals: {
			emdash: {
				db: opts.db,
			},
		},
		session: session as unknown as APIContext["session"],
		redirect: (path: string, status = 302) =>
			Response.redirect(new URL(path, url).toString(), status),
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
	} as unknown as APIContext;
}

async function extractTokenFromEmail(
	adapter: AuthAdapter,
	db: Kysely<Database>,
	email: string,
): Promise<string> {
	const sentEmails: Array<{
		to: string;
		subject: string;
		text: string;
		html: string;
	}> = [];

	await sendMagicLink(
		{
			baseUrl: "https://example.com",
			siteName: "Test Site",
			email: async (message) => {
				sentEmails.push(message);
			},
		},
		adapter,
		email,
	);

	expect(sentEmails).toHaveLength(1);
	const linkUrl = new URL(
		((sentEmails[0] as { text: string }).text.match(/https:\/\/[^\s]+/) ?? [""])[0],
	);
	const token = linkUrl.searchParams.get("token");
	expect(token).toBeTruthy();
	// eslint-disable-next-line typescript/no-non-null-assertion -- asserted above
	return token!;
}

describe("GET /_emdash/api/auth/magic-link/verify", () => {
	let db: Kysely<Database>;
	let adapter: AuthAdapter;

	beforeEach(async () => {
		db = await setupTestDatabase();
		adapter = createKyselyAdapter(db);
		await adapter.createUser({
			email: "author@example.com",
			name: "Author",
			role: Role.AUTHOR,
			emailVerified: true,
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("renders an HTML confirmation page and does not consume the token", async () => {
		const token = await extractTokenFromEmail(adapter, db, "author@example.com");

		const request = new Request(
			`https://example.com/_emdash/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
		);
		const sessionData: SessionData = {};
		const response = await verifyGet(buildContext({ db, request, sessionData }));

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/html");

		const body = await response.text();
		expect(body).toContain(token);
		expect(body).toContain("<form");
		expect(body).toContain('method="POST"');

		// Verify the token is still valid by successfully using it on POST.
		const postRequest = new Request("https://example.com/_emdash/api/auth/magic-link/verify", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Origin: "https://example.com",
			},
			body: new URLSearchParams({ token }),
		});
		const postResponse = await verifyPost(buildContext({ db, request: postRequest, sessionData }));
		expect(postResponse.status).toBe(302);
		expect(postResponse.headers.get("Location")).toBe("https://example.com/_emdash/admin");
	});

	it("redirects to login when the token is missing", async () => {
		const request = new Request("https://example.com/_emdash/api/auth/magic-link/verify");
		const response = await verifyGet(buildContext({ db, request }));

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toContain("error=missing_token");
	});
});

describe("POST /_emdash/api/auth/magic-link/verify", () => {
	let db: Kysely<Database>;
	let adapter: AuthAdapter;

	beforeEach(async () => {
		db = await setupTestDatabase();
		adapter = createKyselyAdapter(db);
		await adapter.createUser({
			email: "author@example.com",
			name: "Author",
			role: Role.AUTHOR,
			emailVerified: true,
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("consumes a valid token, creates a session, and redirects", async () => {
		const token = await extractTokenFromEmail(adapter, db, "author@example.com");
		const sessionData: SessionData = {};

		const request = new Request("https://example.com/_emdash/api/auth/magic-link/verify", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Origin: "https://example.com",
			},
			body: new URLSearchParams({ token, redirect: "/_emdash/admin/some-page" }),
		});

		const response = await verifyPost(buildContext({ db, request, sessionData }));

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("https://example.com/_emdash/admin/some-page");
		expect(sessionData.user).toEqual({ id: expect.any(String) });

		// Token is single-use
		const second = new Request("https://example.com/_emdash/api/auth/magic-link/verify", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Origin: "https://example.com",
			},
			body: new URLSearchParams({ token }),
		});
		const secondResponse = await verifyPost(buildContext({ db, request: second }));
		expect(secondResponse.status).toBe(302);
		expect(secondResponse.headers.get("Location")).toContain("error=invalid_link");
	});

	it("rejects cross-origin POST requests", async () => {
		const token = await extractTokenFromEmail(adapter, db, "author@example.com");

		const request = new Request("https://example.com/_emdash/api/auth/magic-link/verify", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Origin: "https://evil.example",
			},
			body: new URLSearchParams({ token }),
		});

		const response = await verifyPost(buildContext({ db, request }));
		expect(response.status).toBe(403);
	});

	it("rejects an invalid token with a login error redirect", async () => {
		const request = new Request("https://example.com/_emdash/api/auth/magic-link/verify", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Origin: "https://example.com",
			},
			body: new URLSearchParams({ token: "not-a-real-token" }),
		});

		const response = await verifyPost(buildContext({ db, request }));
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toContain("error=invalid_link");
	});

	it("accepts a JSON body with the token", async () => {
		const token = await extractTokenFromEmail(adapter, db, "author@example.com");
		const sessionData: SessionData = {};

		const request = new Request("https://example.com/_emdash/api/auth/magic-link/verify", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "https://example.com",
			},
			body: JSON.stringify({ token }),
		});

		const response = await verifyPost(buildContext({ db, request, sessionData }));
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("https://example.com/_emdash/admin");
		expect(sessionData.user).toEqual({ id: expect.any(String) });
	});
});
