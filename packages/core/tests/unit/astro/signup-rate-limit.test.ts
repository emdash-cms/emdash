/**
 * Rate-limit enforcement on POST /_emdash/api/auth/signup/request.
 *
 * The signup request route must be rate-limited per IP, mirroring the
 * existing protection on magic-link/send. Without a limit, a caller on
 * Cloudflare can trigger unlimited signup verification emails for any
 * allowed domain.
 *
 * Tests drive the route handler directly with a real in-memory SQLite
 * database (so checkRateLimit actually persists) and a stubbed email
 * pipeline to observe send counts.
 */

import { Role } from "@emdash-cms/auth";
import type { AuthAdapter } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as signupRequest } from "../../../src/astro/routes/api/auth/signup/request.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

// Simulate a Cloudflare request so getClientIp returns a value. Without the
// `cf` marker, the rate limiter short-circuits with null-IP and nothing is
// enforced.
function cfRequest(url: string, body: unknown): Request {
	const req = new Request(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"cf-connecting-ip": "198.51.100.7",
		},
		body: JSON.stringify(body),
	});
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- test harness
	(req as unknown as { cf: Record<string, unknown> }).cf = { country: "US" };
	return req;
}

interface StubEmail {
	send: ReturnType<typeof vi.fn>;
	isAvailable: () => boolean;
}

function buildEmail(): StubEmail {
	return {
		send: vi.fn().mockResolvedValue(undefined),
		isAvailable: () => true,
	};
}

function ctx(opts: {
	db: Kysely<Database>;
	email: StubEmail;
	body: { email: string };
}): APIContext {
	const url = "http://localhost/_emdash/api/auth/signup/request";
	return {
		request: cfRequest(url, opts.body),
		locals: {
			emdash: {
				db: opts.db,
				email: opts.email,
			},
		},
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- minimal stub for tests
	} as unknown as APIContext;
}

describe("POST /auth/signup/request rate limiting", () => {
	let db: Kysely<Database>;
	let adapter: AuthAdapter;

	beforeEach(async () => {
		db = await setupTestDatabase();
		adapter = createKyselyAdapter(db);
		await adapter.createAllowedDomain("allowed.com", Role.AUTHOR);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("sends email on the first request from an IP", async () => {
		const email = buildEmail();
		const res = await signupRequest(ctx({ db, email, body: { email: "a@allowed.com" } }));
		expect(res.status).toBe(200);
		expect(email.send).toHaveBeenCalledTimes(1);
	});

	it("stops sending emails after the per-IP limit is exceeded", async () => {
		const email = buildEmail();

		// Use 4 distinct addresses so each one would normally send — if the
		// limit is absent, the stub is called 4 times. With the fix, it's 3.
		for (const local of ["a", "b", "c", "d"]) {
			await signupRequest(ctx({ db, email, body: { email: `${local}@allowed.com` } }));
		}

		// Matches magic-link/send: 3 requests per 5 minutes per IP.
		expect(email.send).toHaveBeenCalledTimes(3);
	});

	it("always returns 200 to avoid revealing the rate limit", async () => {
		const email = buildEmail();
		const responses = [];
		for (const local of ["a", "b", "c", "d", "e"]) {
			responses.push(
				await signupRequest(ctx({ db, email, body: { email: `${local}@allowed.com` } })),
			);
		}

		// All responses are 200 with the generic success envelope. The rate
		// limit is invisible to the caller (which also keeps signup
		// indistinguishable from disallowed-domain).
		expect(responses.every((r) => r.status === 200)).toBe(true);
	});

	it("tracks the limit per IP, not globally", async () => {
		const email = buildEmail();
		const url = "http://localhost/_emdash/api/auth/signup/request";

		function req(ip: string, addr: string): Request {
			const r = new Request(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"cf-connecting-ip": ip,
				},
				body: JSON.stringify({ email: addr }),
			});
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- test harness
			(r as unknown as { cf: Record<string, unknown> }).cf = { country: "US" };
			return r;
		}

		function makeCtx(request: Request): APIContext {
			return {
				request,
				locals: { emdash: { db, email } },
				// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- minimal stub
			} as unknown as APIContext;
		}

		// Exhaust IP A
		for (const local of ["a", "b", "c", "d"]) {
			await signupRequest(makeCtx(req("198.51.100.7", `${local}@allowed.com`)));
		}
		expect(email.send).toHaveBeenCalledTimes(3);

		// IP B still gets through
		await signupRequest(makeCtx(req("198.51.100.8", "x@allowed.com")));
		expect(email.send).toHaveBeenCalledTimes(4);
	});
});
