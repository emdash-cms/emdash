/**
 * Turnstile on the admin's email sign-in and self-signup endpoints.
 *
 * Drives the route handlers with a real SQLite database, a stubbed email
 * pipeline, and a stubbed siteverify endpoint that accepts only "good-token".
 */

import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildEmDashCsp } from "../../../src/astro/middleware/csp.js";
import { POST as magicLinkSend } from "../../../src/astro/routes/api/auth/magic-link/send.js";
import { GET as authMode } from "../../../src/astro/routes/api/auth/mode.js";
import { POST as signupRequest } from "../../../src/astro/routes/api/auth/signup/request.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function ctx(db: Kysely<Database>, send: ReturnType<typeof vi.fn>, path: string, body?: unknown) {
	const request = new Request(`http://localhost/_emdash/api/auth/${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return {
		request,
		locals: { emdash: { db, email: { send, isAvailable: () => true } } },
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
	} as unknown as APIContext;
}

describe("Turnstile on admin auth forms", () => {
	let db: Kysely<Database>;
	let send: ReturnType<typeof vi.fn>;
	const realFetch = globalThis.fetch;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const adapter = createKyselyAdapter(db);
		await adapter.createAllowedDomain("allowed.com", Role.AUTHOR);
		await adapter.createUser({
			email: "author@allowed.com",
			name: "Author",
			role: Role.AUTHOR,
			emailVerified: true,
		});
		send = vi.fn().mockResolvedValue(undefined);
		vi.stubEnv("EMDASH_TURNSTILE_SECRET_KEY", "secret");
		vi.stubEnv("EMDASH_TURNSTILE_SITE_KEY", "site-key");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : input.toString();
				if (url !== SITEVERIFY_URL) return realFetch(input, init);
				const { response } = JSON.parse(init?.body as string) as { response: string };
				return Response.json({ success: response === "good-token" });
			}),
		);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		await teardownTestDatabase(db);
	});

	it("rejects a magic link request without a valid token", async () => {
		for (const turnstileToken of [undefined, "bad-token"]) {
			const res = await magicLinkSend(
				ctx(db, send, "magic-link/send", { email: "author@allowed.com", turnstileToken }),
			);
			expect(res.status).toBe(403);
			const body = (await res.json()) as { error: { code: string } };
			expect(body.error.code).toBe("TURNSTILE_FAILED");
		}
		expect(send).not.toHaveBeenCalled();
	});

	it("sends a magic link when the token verifies", async () => {
		const res = await magicLinkSend(
			ctx(db, send, "magic-link/send", {
				email: "author@allowed.com",
				turnstileToken: "good-token",
			}),
		);
		expect(res.status).toBe(200);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("rejects a signup request without a valid token", async () => {
		const res = await signupRequest(
			ctx(db, send, "signup/request", { email: "new@allowed.com", turnstileToken: "bad-token" }),
		);
		expect(res.status).toBe(403);
		expect(send).not.toHaveBeenCalled();
	});

	it("sends a signup email when the token verifies", async () => {
		const res = await signupRequest(
			ctx(db, send, "signup/request", { email: "new@allowed.com", turnstileToken: "good-token" }),
		);
		expect(res.status).toBe(200);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("does not challenge the auth forms when only the secret key is set", async () => {
		vi.stubEnv("EMDASH_TURNSTILE_SITE_KEY", "");

		const magic = await magicLinkSend(
			ctx(db, send, "magic-link/send", { email: "author@allowed.com" }),
		);
		const signup = await signupRequest(
			ctx(db, send, "signup/request", { email: "new@allowed.com" }),
		);
		expect(magic.status).toBe(200);
		expect(signup.status).toBe(200);
		expect(send).toHaveBeenCalledTimes(2);

		const mode = (await (await authMode(ctx(db, send, "mode"))).json()) as {
			data: { turnstileSiteKey?: string };
		};
		expect(mode.data.turnstileSiteKey).toBeUndefined();
	});

	it("publishes the site key, never the secret, on the auth mode endpoint", async () => {
		const res = await authMode(ctx(db, send, "mode"));
		const text = await res.text();
		expect(JSON.parse(text).data.turnstileSiteKey).toBe("site-key");
		expect(text).not.toContain("secret");
	});

	it("allows the Turnstile script and iframe in the admin CSP only when enabled", () => {
		const directive = (csp: string, name: string) =>
			csp.split("; ").find((d) => d.startsWith(`${name} `));

		const off = buildEmDashCsp();
		expect(directive(off, "script-src")).toBe("script-src 'self' 'unsafe-inline'");

		const on = buildEmDashCsp(undefined, undefined, true);
		expect(directive(on, "script-src")).toContain("https://challenges.cloudflare.com");
		expect(on.split("; ").filter((d) => d.startsWith("frame-src "))).toEqual([
			"frame-src 'self' https:",
		]);
	});
});
