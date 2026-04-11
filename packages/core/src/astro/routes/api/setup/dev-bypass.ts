/**
 * POST /_emdash/api/setup/dev-bypass
 * GET  /_emdash/api/setup/dev-bypass
 *
 * Development-only endpoint to bypass the setup wizard.
 * Runs migrations, creates a dev admin user, and marks setup complete.
 *
 * ONLY available when import.meta.env.DEV is true.
 *
 * Usage:
 * - GET with redirect: /_emdash/api/setup/dev-bypass?redirect=/_emdash/admin
 * - POST for API: Returns JSON with setup info
 *
 * For agent/browser testing, navigate to:
 *   /_emdash/api/setup/dev-bypass?redirect=/_emdash/admin
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { encryptWithHKDF } from "@emdash-cms/auth";
import { generateHOTP } from "@oslojs/otp";
import { ulid } from "ulidx";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { escapeHtml } from "#api/escape.js";
import { handleApiTokenCreate } from "#api/handlers/api-tokens.js";
import { isSafeRedirect } from "#api/redirect.js";
import { resolveAuthSecret } from "#auth/auth-secret.js";
import { runMigrations } from "#db/migrations/runner.js";
import { OptionsRepository } from "#db/repositories/options.js";
import { applySeed } from "#seed/apply.js";
import { loadSeed } from "#seed/load.js";
import { validateSeed } from "#seed/validate.js";

/**
 * Well-known test TOTP secret — the 20-byte ASCII string "12345678901234567890"
 * from RFC 6238 Appendix B. Agent-browser tests can generate the current
 * code deterministically from this secret, so the test doesn't need to
 * poke at the authenticator UI.
 */
const DEV_TOTP_SECRET_BYTES = new TextEncoder().encode("12345678901234567890");
const DEV_TOTP_SECRET_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

// RBAC role levels (matching @emdash-cms/auth)
const ROLE_ADMIN = 50;

const DEV_USER_EMAIL = "dev@emdash.local";
const DEV_USER_NAME = "Dev Admin";
const DEV_SITE_TITLE = "EmDash Dev Site";

async function handleDevBypass(context: Parameters<APIRoute>[0]): Promise<Response> {
	// CRITICAL: Only allow in development mode
	if (!import.meta.env.DEV) {
		return apiError("FORBIDDEN", "Dev bypass is only available in development mode", 403);
	}

	const { locals, url, session } = context;
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		// Run migrations
		const migrations = await runMigrations(emdash.db);
		console.log("[setup-dev-bypass] Migrations applied:", migrations.applied);

		// Apply seed (user seed or built-in default)
		const seed = await loadSeed();
		const validation = validateSeed(seed);
		if (validation.valid) {
			const seedResult = await applySeed(emdash.db, seed, {
				includeContent: true,
				onConflict: "skip",
				storage: emdash.storage ?? undefined,
			});
			console.log(
				`[setup-dev-bypass] Seed applied: ${seedResult.collections.created} collections, ${seedResult.fields.created} fields`,
			);
		}

		const options = new OptionsRepository(emdash.db);

		// Find or create dev user (direct DB access to avoid @emdash-cms/auth import issues in dev)
		const existingUser = await emdash.db
			.selectFrom("users")
			.selectAll()
			.where("email", "=", DEV_USER_EMAIL)
			.executeTakeFirst();

		let user: { id: string; email: string; name: string; role: number };
		let userCreated = false;

		if (!existingUser) {
			const now = new Date().toISOString();
			const newUser = {
				id: ulid(),
				email: DEV_USER_EMAIL,
				name: DEV_USER_NAME,
				role: ROLE_ADMIN,
				email_verified: 1,
				created_at: now,
				updated_at: now,
			};

			await emdash.db.insertInto("users").values(newUser).execute();

			user = {
				id: newUser.id,
				email: newUser.email,
				name: newUser.name,
				role: newUser.role,
			};
			userCreated = true;
			console.log("[setup-dev-bypass] Created dev admin user:", user.email);
		} else {
			user = {
				id: existingUser.id,
				email: existingUser.email,
				name: existingUser.name || DEV_USER_NAME,
				role: existingUser.role,
			};
		}

		// Set site title if not already set
		const existingTitle = await options.get("emdash:site_title");
		if (!existingTitle) {
			await options.set("emdash:site_title", DEV_SITE_TITLE);
		}

		// Store canonical site URL (used by magic-link/recovery emails)
		await options.set("emdash:site_url", url.origin);

		// Mark setup complete
		await options.set("emdash:setup_complete", true);

		// Create session
		if (session) {
			session.set("user", { id: user.id });
		}

		// Optionally provision a known-seed TOTP credential (?totp=1)
		// so agent-browser tests can exercise the TOTP login flow.
		// The secret is the RFC 6238 Appendix B test vector, so the
		// current 6-digit code can be computed deterministically from
		// Date.now() without any server round-trip.
		let currentTotpCode: string | undefined;
		if (url.searchParams.has("totp")) {
			const secretResult = resolveAuthSecret();
			if (secretResult.ok) {
				// Encrypt the base32 secret and upsert a totp_secrets row
				// for the dev user. If one already exists from a prior
				// dev-bypass call, overwrite it so tests get a clean
				// state machine (last_used_step=0, failed_attempts=0,
				// no lockout).
				const encrypted = await encryptWithHKDF(DEV_TOTP_SECRET_BASE32, secretResult.secret);
				await emdash.db.deleteFrom("totp_secrets").where("user_id", "=", user.id).execute();
				const now = new Date().toISOString();
				await emdash.db
					.insertInto("totp_secrets")
					.values({
						user_id: user.id,
						encrypted_secret: encrypted,
						algorithm: "SHA1",
						digits: 6,
						period: 30,
						last_used_step: 0,
						failed_attempts: 0,
						locked_until: null,
						verified: 1,
						created_at: now,
						updated_at: now,
					})
					.execute();

				// Compute the current code so the caller can use it
				// immediately without having to know the secret.
				const step = BigInt(Math.floor(Date.now() / 30000));
				currentTotpCode = generateHOTP(DEV_TOTP_SECRET_BYTES, step, 6);
			}
		}

		// Optionally create a PAT token (?token=1) for headless/CLI testing.
		let token: string | undefined;
		if (url.searchParams.has("token")) {
			const result = await handleApiTokenCreate(emdash.db, user.id, {
				name: "dev-bypass-token",
				scopes: [
					"content:read",
					"content:write",
					"media:read",
					"media:write",
					"schema:read",
					"schema:write",
					"admin",
				],
			});
			if (result.success) {
				token = result.data.token;
			}
		}

		// Check for redirect parameter
		const redirect = url.searchParams.get("redirect");

		if (redirect) {
			// Validate redirect is a safe local path (prevent open redirect via //evil.com or /\evil.com)
			if (!isSafeRedirect(redirect)) {
				return apiError("INVALID_REDIRECT", "Redirect must be a local path", 400);
			}

			// Return an HTML page with meta-refresh redirect
			// This ensures the session is fully saved before redirect
			const safeRedirect = escapeHtml(redirect);
			const html = `<!DOCTYPE html>
<html>
<head>
	<meta http-equiv="refresh" content="0;url=${safeRedirect}">
</head>
<body>Redirecting...</body>
</html>`;
			return new Response(html, {
				status: 200,
				headers: { "Content-Type": "text/html" },
			});
		}

		// Return JSON response
		return apiSuccess({
			success: true,
			message: "Dev setup complete",
			migrations: migrations.applied,
			userCreated,
			user: {
				id: user.id,
				email: user.email,
				name: user.name,
				role: user.role,
			},
			...(token ? { token } : {}),
			...(currentTotpCode
				? { totp: { secret: DEV_TOTP_SECRET_BASE32, currentCode: currentTotpCode } }
				: {}),
		});
	} catch (error) {
		return handleError(error, "Dev bypass failed", "DEV_BYPASS_ERROR");
	}
}

// Support both GET and POST
export const GET: APIRoute = handleDevBypass;
export const POST: APIRoute = handleDevBypass;
