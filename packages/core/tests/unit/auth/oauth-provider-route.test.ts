/**
 * OAuth provider route unit tests
 *
 * Covers the GET /_emdash/api/auth/oauth/[provider] handler, focusing on
 * environment variable resolution across runtimes:
 *   - Astro v5 Cloudflare: locals.runtime.env
 *   - Astro v6 Cloudflare: cloudflare:workers (locals.runtime.env throws)
 *   - Node.js / Vite: import.meta.env
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "../../../src/astro/routes/api/auth/oauth/[provider].js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRedirect(captured: { url?: string }) {
	return (url: string) => {
		captured.url = url;
		return new Response(null, { status: 302, headers: { Location: url } });
	};
}

function makeLocals(db: Kysely<Database>, runtime?: unknown) {
	return { emdash: { db, config: {} }, ...(runtime !== undefined ? { runtime } : {}) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OAuth provider route — environment resolution", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		vi.unstubAllEnvs();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		vi.unstubAllEnvs();
	});

	it("redirects to GitHub authorization URL when env vars are in import.meta.env", async () => {
		vi.stubEnv("EMDASH_OAUTH_GITHUB_CLIENT_ID", "test-client-id");
		vi.stubEnv("EMDASH_OAUTH_GITHUB_CLIENT_SECRET", "test-client-secret");

		const captured: { url?: string } = {};
		const response = await GET({
			params: { provider: "github" },
			request: new Request("http://localhost:4321/_emdash/api/auth/oauth/github"),
			locals: makeLocals(db) as Parameters<typeof GET>[0]["locals"],
			redirect: makeRedirect(captured),
		} as Parameters<typeof GET>[0]);

		expect(response.status).toBe(302);
		expect(captured.url).toContain("github.com/login/oauth/authorize");
		expect(captured.url).toContain("client_id=test-client-id");
	});

	it("redirects to error page when provider is not configured", async () => {
		// No env vars set
		const captured: { url?: string } = {};
		const response = await GET({
			params: { provider: "github" },
			request: new Request("http://localhost:4321/_emdash/api/auth/oauth/github"),
			locals: makeLocals(db) as Parameters<typeof GET>[0]["locals"],
			redirect: makeRedirect(captured),
		} as Parameters<typeof GET>[0]);

		expect(response.status).toBe(302);
		expect(captured.url).toContain("error=provider_not_configured");
	});

	it("falls back gracefully when locals.runtime.env throws (Astro v6 Cloudflare)", async () => {
		vi.stubEnv("EMDASH_OAUTH_GITHUB_CLIENT_ID", "test-client-id");
		vi.stubEnv("EMDASH_OAUTH_GITHUB_CLIENT_SECRET", "test-client-secret");

		// Simulate Astro v6: locals.runtime exists but .env getter throws
		const runtimeWithThrowingEnv = {
			get env(): never {
				throw new Error(
					"Astro.locals.runtime.env has been removed in Astro v6. " +
						"Use 'import { env } from \"cloudflare:workers\"' instead.",
				);
			},
		};

		const captured: { url?: string } = {};
		const response = await GET({
			params: { provider: "github" },
			request: new Request("http://localhost:4321/_emdash/api/auth/oauth/github"),
			locals: makeLocals(db, runtimeWithThrowingEnv) as Parameters<typeof GET>[0]["locals"],
			redirect: makeRedirect(captured),
		} as Parameters<typeof GET>[0]);

		// Must redirect to GitHub OAuth, NOT to the oauth_error page
		expect(response.status).toBe(302);
		expect(captured.url).not.toContain("error=oauth_error");
		expect(captured.url).toContain("github.com/login/oauth/authorize");
	});

	it("redirects to error page for an unknown provider", async () => {
		const captured: { url?: string } = {};
		const response = await GET({
			params: { provider: "unknown" },
			request: new Request("http://localhost:4321/_emdash/api/auth/oauth/unknown"),
			locals: makeLocals(db) as Parameters<typeof GET>[0]["locals"],
			redirect: makeRedirect(captured),
		} as Parameters<typeof GET>[0]);

		expect(response.status).toBe(302);
		expect(captured.url).toContain("error=invalid_provider");
	});

	it("redirects to error page when db is not available", async () => {
		const captured: { url?: string } = {};
		const response = await GET({
			params: { provider: "github" },
			request: new Request("http://localhost:4321/_emdash/api/auth/oauth/github"),
			locals: { emdash: null } as unknown as Parameters<typeof GET>[0]["locals"],
			redirect: makeRedirect(captured),
		} as Parameters<typeof GET>[0]);

		expect(response.status).toBe(302);
		expect(captured.url).toContain("error=server_error");
	});
});
