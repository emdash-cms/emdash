/**
 * POST /_emdash/api/setup/admin-totp
 *
 * Start first-run admin creation via the TOTP (authenticator app)
 * path. Generates a fresh TOTP secret, encrypts it with HKDF, stores
 * the pending state in auth_challenges keyed by a random challenge ID,
 * and returns the otpauth:// URI (for QR rendering), the base32 secret
 * (for the "Can't scan?" fallback), and the plaintext recovery codes
 * (shown once — the server only stores hashes).
 *
 * Guards (same as the passkey setup route):
 * - setup must NOT be complete already
 * - zero users must exist (first admin only)
 * - rate-limited 5/15min per IP
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import { encryptWithHKDF } from "@emdash-cms/auth";
import {
	buildOtpAuthURI,
	generateRecoveryCodes,
	generateTOTPSecret,
	hashRecoveryCode,
} from "@emdash-cms/auth/totp";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { setupAdminTotpBody } from "#api/schemas.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "#auth/rate-limit.js";
import { isTotpEnabled } from "#auth/totp-config.js";
import { createTOTPSetupChallenge } from "#auth/totp-setup-store.js";
import { OptionsRepository } from "#db/repositories/options.js";

/**
 * Read the EMDASH_AUTH_SECRET env var. Throws a user-visible error if
 * unset — you cannot encrypt secrets without a key, and silently falling
 * back to a hardcoded value would leak the encrypted blob. The checked
 * name is the same one `emdash auth secret` outputs and the docs
 * instruct deployers to set.
 */
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

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	// TOTP can be disabled at the config level. Return 404 rather than
	// 403 so the feature looks invisible to callers — same response
	// shape a missing route would produce.
	if (!isTotpEnabled(emdash.config)) {
		return apiError("NOT_FOUND", "Not found", 404);
	}

	try {
		// Rate limit before doing any cryptographic work.
		const ip = getClientIp(request);
		const rateLimit = await checkRateLimit(emdash.db, ip, "setup/admin-totp", 5, 15 * 60);
		if (!rateLimit.allowed) {
			return rateLimitResponse(15 * 60);
		}

		// Guard: setup must not already be complete.
		const options = new OptionsRepository(emdash.db);
		const setupComplete = await options.get("emdash:setup_complete");
		if (setupComplete === true || setupComplete === "true") {
			return apiError("SETUP_COMPLETE", "Setup already complete", 400);
		}

		// Guard: zero users must exist (first admin only).
		const adapter = createKyselyAdapter(emdash.db);
		const userCount = await adapter.countUsers();
		if (userCount > 0) {
			return apiError("ADMIN_EXISTS", "Admin user already exists", 400);
		}

		// Parse request body.
		const body = await parseBody(request, setupAdminTotpBody);
		if (isParseError(body)) return body;

		const normalizedEmail = body.email.toLowerCase();
		const name = body.name ?? null;

		// Generate the TOTP secret bytes and the base32 encoding for
		// the "Can't scan?" fallback the setup UI surfaces under a
		// disclosure.
		const { keyBytes, base32Secret } = generateTOTPSecret();

		// Encrypt the base32 string (NOT the raw bytes — base32 is
		// already text and survives round-tripping through the HKDF
		// path untouched). The decrypt side in admin-totp-verify will
		// decode it back into bytes before handing it to verifyTOTPCode.
		const authSecret = resolveAuthSecret();
		const encryptedSecret = await encryptWithHKDF(base32Secret, authSecret);

		// Generate the recovery codes NOW so their hashes can be stored
		// in the setup-challenge row alongside the encrypted secret.
		// The route returns the plaintext codes to the client so they
		// can be displayed once, but only the hashes ever touch disk.
		const recoveryCodes = generateRecoveryCodes();
		const recoveryCodeHashes = recoveryCodes.map(hashRecoveryCode);

		// Persist the pending state in auth_challenges with a 15-minute
		// TTL. The returned challengeId is what the verify route keys
		// on when the user submits their first 6-digit code.
		const challengeId = await createTOTPSetupChallenge(emdash.db, {
			email: normalizedEmail,
			name,
			encryptedSecret,
			recoveryCodeHashes,
		});

		// Build the otpauth:// URI for QR rendering. The issuer label
		// precedence is: explicit config.totp.issuer → site title from
		// options → "EmDash" as the last-ditch fallback.
		const siteName = (await options.get<string>("emdash:site_title")) ?? "EmDash";
		const issuer = emdash.config.totp?.issuer ?? siteName;
		const otpauthUri = buildOtpAuthURI({
			issuer,
			accountName: normalizedEmail,
			keyBytes,
		});

		return apiSuccess({
			success: true,
			challengeId,
			otpauthUri,
			base32Secret,
			recoveryCodes,
		});
	} catch (error) {
		return handleError(error, "Failed to start TOTP setup", "SETUP_ADMIN_TOTP_ERROR");
	}
};
