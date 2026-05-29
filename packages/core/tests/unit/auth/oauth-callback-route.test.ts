/**
 * OAuth callback route unit tests
 *
 * Covers the GET /_emdash/api/auth/oauth/[provider]/callback handler, focusing on
 * environment variable resolution across runtimes:
 *   - Astro v5 Cloudflare: locals.runtime.env
 *   - Astro v6 Cloudflare: cloudflare:workers (locals.runtime.env throws)
 *   - Node.js / Vite: import.meta.env
 *
 * The callback shares the exact env-resolution fallback added to the
 * initiation route ([provider].ts); these tests guard against the Astro v6
 * regression where reading `locals.runtime.env` throws.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "../../../src/astro/routes/api/auth/oauth/[provider]/callback.js";
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

/** Build a callback request with code + state so it gets past param validation. */
function callbackRequest() {
	return new Request(
		"http://localhost:4321/_emdash/api/auth/oauth/github/callback?code=test-code&state=test-state",
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OAuth callback route — environment resolution", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		vi.unstubAllEnvs();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		vi.unstubAllEnvs();
	});

	it("resolves env from import.meta.env and reaches OAuth state validation", async () => {
		vi.stubEnv("EMDASH_OAUTH_GITHUB_CLIENT_ID", "test-client-id");
		vi.stubEnv("EMDASH_OAUTH_GITHUB_CLIENT_SECRET", "test-client-secret");

		const captured: { url?: string } = {};
		const response = await GET({
			params: { provider: "github" },
			request: callbackRequest(),
			locals: makeLocals(db) as Parameters<typeof GET>[0]["locals"],
			redirect: makeRedirect(captured),
		} as Parameters<typeof GET>[0]);

		// Provider is configured, so it reaches handleOAuthCallback, which rejects
		// the unknown state — proving env resolved with the GitHub credentials.
		expect(response.status).toBe(302);
		expect(captured.url).not.toContain("error=provider_not_configured");
		expect(captured.url).toContain("error=invalid_state");
	});

	it("redirects to provider_not_configured when env vars are absent", async () => {
		const captured: { url?: string } = {};
		const response = await GET({
			params: { provider: "github" },
			request: callbackRequest(),
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
			request: callbackRequest(),
			locals: makeLocals(db, runtimeWithThrowingEnv) as Parameters<typeof GET>[0]["locals"],
			redirect: makeRedirect(captured),
		} as Parameters<typeof GET>[0]);

		// The thrown getter must be caught by the env fallback, NOT bubble up to the
		// outer catch (which would yield error=oauth_error). With env resolved, the
		// provider is configured and the flow reaches OAuth state validation.
		expect(response.status).toBe(302);
		expect(captured.url).not.toContain("error=oauth_error");
		expect(captured.url).not.toContain("error=provider_not_configured");
		expect(captured.url).toContain("error=invalid_state");
	});

	it("redirects to invalid_callback when code or state is missing", async () => {
		const captured: { url?: string } = {};
		const response = await GET({
			params: { provider: "github" },
			request: new Request("http://localhost:4321/_emdash/api/auth/oauth/github/callback"),
			locals: makeLocals(db) as Parameters<typeof GET>[0]["locals"],
			redirect: makeRedirect(captured),
		} as Parameters<typeof GET>[0]);

		expect(response.status).toBe(302);
		expect(captured.url).toContain("error=invalid_callback");
	});
});
