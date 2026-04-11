/**
 * POST /_emdash/api/setup/admin-totp-verify
 *
 * Complete first-run admin creation via the TOTP path. The client sends
 * back the challengeId it received from /admin-totp plus the 6-digit
 * code the user just read from their authenticator app. This route:
 *
 *   1. Rate-limits per IP (defense against brute-forcing the 6-digit code)
 *   2. Looks up the pending setup challenge (returns 400 if missing/expired)
 *   3. Decrypts the stored TOTP secret via HKDF
 *   4. Verifies the code against the current + ±1 period drift window
 *   5. Creates the admin user, the totp_secrets row, the recovery tokens,
 *      and marks setup complete — in that order, with defensive cleanup
 *      if any step fails mid-way (we can't use a single DB transaction
 *      because D1 doesn't support them; see 019_i18n.ts for the same
 *      pattern)
 *   6. Sets the session cookie so the user is logged in and redirected
 *      to /_emdash/admin without having to re-authenticate
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { Role, decryptWithHKDF } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import { verifyTOTPCode } from "@emdash-cms/auth/totp";
import { decodeBase32IgnorePadding } from "@oslojs/encoding";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { setupAdminTotpVerifyBody } from "#api/schemas.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "#auth/rate-limit.js";
import {
	deleteTOTPSetupChallenge,
	getTOTPSetupChallenge,
} from "#auth/totp-setup-store.js";
import { OptionsRepository } from "#db/repositories/options.js";

/** Recovery codes are set to expire far in the future so the NOT NULL
 * expires_at constraint on auth_tokens is satisfied without the codes
 * ever actually expiring in practice. */
const RECOVERY_CODE_EXPIRY_YEARS = 100;

function resolveAuthSecret(): string {
	const secret = import.meta.env.EMDASH_AUTH_SECRET || import.meta.env.AUTH_SECRET || "";
	if (!secret || secret.length < 32) {
		throw new Error(
			"EMDASH_AUTH_SECRET is not set or is too short (min 32 chars). " +
				"Generate one with `emdash auth secret` and set it in your env.",
		);
	}
	return secret;
}

export const POST: APIRoute = async ({ request, locals, session }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		// Rate limit before doing any cryptographic work — at 5/15min an
		// attacker gets at most 5 attempts per IP to brute-force the
		// 6-digit code (keyspace = 10^6), which is still gated by the
		// single-use challengeId, so effective surface is near-zero.
		const ip = getClientIp(request);
		const rateLimit = await checkRateLimit(
			emdash.db,
			ip,
			"setup/admin-totp-verify",
			5,
			15 * 60,
		);
		if (!rateLimit.allowed) {
			return rateLimitResponse(15 * 60);
		}

		// Parse body. The zod schema rejects malformed codes (non-6-digit)
		// before we do any DB or HMAC work.
		const body = await parseBody(request, setupAdminTotpVerifyBody);
		if (isParseError(body)) return body;

		// Re-check the setup-not-complete guard inside the handler.
		// The initial check happened on /admin-totp when the challenge
		// was created; we re-check here because the user may have
		// completed setup via the passkey path in a parallel tab.
		const options = new OptionsRepository(emdash.db);
		const setupComplete = await options.get("emdash:setup_complete");
		if (setupComplete === true || setupComplete === "true") {
			return apiError("SETUP_COMPLETE", "Setup already complete", 400);
		}

		// Re-check the zero-users guard for the same reason.
		const adapter = createKyselyAdapter(emdash.db);
		const userCount = await adapter.countUsers();
		if (userCount > 0) {
			return apiError("ADMIN_EXISTS", "Admin user already exists", 400);
		}

		// Look up the pending setup state.
		const challenge = await getTOTPSetupChallenge(emdash.db, body.challengeId);
		if (!challenge) {
			return apiError(
				"INVALID_STATE",
				"Setup session expired or invalid. Please restart setup.",
				400,
			);
		}

		// Decrypt the stored base32 secret and decode it to raw bytes
		// for the verify primitive.
		const authSecret = resolveAuthSecret();
		let keyBytes: Uint8Array;
		try {
			const base32Secret = await decryptWithHKDF(challenge.encryptedSecret, authSecret);
			keyBytes = decodeBase32IgnorePadding(base32Secret);
		} catch {
			// A decrypt failure here means either the challenge row is
			// corrupted or EMDASH_AUTH_SECRET has rotated since the
			// challenge was created. Either way, the user needs to
			// restart — we don't want to leak which case it is.
			await deleteTOTPSetupChallenge(emdash.db, body.challengeId);
			return apiError(
				"INVALID_STATE",
				"Setup session expired or invalid. Please restart setup.",
				400,
			);
		}

		// Verify the submitted code. Drift window is ±1 period (default),
		// so the user has about 60 seconds of clock-drift tolerance.
		const result = verifyTOTPCode(keyBytes, body.code);
		if (!result.valid) {
			// Don't consume the challenge on a wrong code — the user
			// should be able to retry (the rate limiter bounds the
			// retries). The UI clears the input and refocuses it.
			return apiError(
				"INVALID_TOTP_CODE",
				"Code didn't match. Check your device clock and try again.",
				400,
			);
		}

		// The code matched. Create the user and credential. We cannot
		// wrap this in a single db.transaction() because D1 doesn't
		// support transactions — same reason migration 019_i18n opts
		// out. Instead we use explicit sequential creates with cleanup
		// on failure: if any step after createUser fails, we delete
		// the user we just created so the next setup attempt starts
		// from a clean slate rather than the "user exists but setup
		// not complete" dead end the passkey flow has today.
		const user = await adapter.createUser({
			email: challenge.email,
			name: challenge.name,
			role: Role.ADMIN,
			emailVerified: false,
		});

		try {
			await adapter.createTOTP({
				userId: user.id,
				encryptedSecret: challenge.encryptedSecret,
				verified: true,
			});

			// Persist the initial replay step. The matched step from
			// verifyTOTPCode becomes the credential's lastUsedStep so
			// a later login cannot reuse the same code within the same
			// 30-second window.
			if (result.usedStep !== null) {
				await adapter.updateTOTP(user.id, { lastUsedStep: result.usedStep });
			}

			// Persist the pre-hashed recovery codes as auth_tokens rows.
			// The plaintext codes were shown once to the user on the
			// /admin-totp response and are never stored.
			const expiresAt = new Date();
			expiresAt.setFullYear(expiresAt.getFullYear() + RECOVERY_CODE_EXPIRY_YEARS);
			for (const hash of challenge.recoveryCodeHashes) {
				await adapter.createToken({
					hash,
					userId: user.id,
					email: challenge.email,
					type: "recovery",
					expiresAt,
				});
			}

			// Mark setup complete LAST so the "user created but setup
			// not complete" state is impossible to observe from an
			// outside reader.
			await options.set("emdash:setup_complete", true);

			// Clean up the pending challenge — it's single-use.
			await deleteTOTPSetupChallenge(emdash.db, body.challengeId);
		} catch (persistError) {
			// Clean up the user so the next attempt starts fresh. We
			// intentionally do NOT re-raise here — we surface a friendly
			// SETUP_ADMIN_TOTP_VERIFY_ERROR instead. The adapter
			// delete cascades to anything it created under user.id
			// (credentials, tokens, the totp_secrets row we may have
			// just written).
			try {
				await adapter.deleteUser(user.id);
			} catch {
				// Swallow cleanup failures — the primary error is
				// what we surface. Leaving a half-created user is the
				// same failure mode the passkey flow has today.
			}
			throw persistError;
		}

		// Set the session cookie so the user lands in /_emdash/admin
		// already authenticated. This is a nicer UX than the passkey
		// setup flow (which requires a separate login), and it's safe
		// because we just proved possession of the TOTP secret.
		if (session) {
			session.set("user", { id: user.id });
		}

		return apiSuccess({
			success: true,
			user: {
				id: user.id,
				email: user.email,
				name: user.name,
				role: user.role,
			},
		});
	} catch (error) {
		return handleError(error, "Failed to verify TOTP setup", "SETUP_ADMIN_TOTP_VERIFY_ERROR");
	}
};
