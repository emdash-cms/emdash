/**
 * POST /_emdash/api/setup/admin-totp-verify — finish first-run TOTP
 * setup. Verifies the 6-digit code against the pending challenge,
 * then creates the admin user, totp_secrets row, recovery tokens,
 * and marks setup complete. Sets the session cookie on success.
 *
 * No db.transaction() wrapper because D1 doesn't support transactions
 * (see 019_i18n.ts for the same opt-out). Instead, createUser runs
 * first and a catch block deletes the user on any later failure so
 * retries start from a clean slate.
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
import { authSecretFailureMessage, resolveAuthSecret } from "#auth/auth-secret.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "#auth/rate-limit.js";
import { isTotpEnabled } from "#auth/totp-config.js";
import {
	deleteTOTPSetupChallenge,
	getTOTPSetupChallenge,
} from "#auth/totp-setup-store.js";
import { OptionsRepository } from "#db/repositories/options.js";

/** Far-future sentinel — auth_tokens.expires_at is NOT NULL. */
const RECOVERY_CODE_EXPIRY_YEARS = 100;

export const POST: APIRoute = async ({ request, locals, session }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	if (!isTotpEnabled(emdash.config)) {
		return apiError("NOT_FOUND", "Not found", 404);
	}

	try {
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

		const body = await parseBody(request, setupAdminTotpVerifyBody);
		if (isParseError(body)) return body;

		// Re-check guards inside the handler — a parallel tab may have
		// completed setup via the passkey path since the challenge was
		// created.
		const options = new OptionsRepository(emdash.db);
		const setupComplete = await options.get("emdash:setup_complete");
		if (setupComplete === true || setupComplete === "true") {
			return apiError("SETUP_COMPLETE", "Setup already complete", 400);
		}

		const adapter = createKyselyAdapter(emdash.db);
		const userCount = await adapter.countUsers();
		if (userCount > 0) {
			return apiError("ADMIN_EXISTS", "Admin user already exists", 400);
		}

		const challenge = await getTOTPSetupChallenge(emdash.db, body.challengeId);
		if (!challenge) {
			return apiError(
				"INVALID_STATE",
				"Setup session expired or invalid. Please restart setup.",
				400,
			);
		}

		const secretResult = resolveAuthSecret();
		if (!secretResult.ok) {
			console.error(
				`[setup/admin-totp-verify] ${authSecretFailureMessage(secretResult.reason)}`,
			);
			return apiError(
				"AUTH_SECRET_MISSING",
				authSecretFailureMessage(secretResult.reason),
				500,
			);
		}

		let keyBytes: Uint8Array;
		try {
			const base32Secret = await decryptWithHKDF(
				challenge.encryptedSecret,
				secretResult.secret,
			);
			keyBytes = decodeBase32IgnorePadding(base32Secret);
		} catch {
			// Corrupt row or rotated auth secret — force a restart.
			await deleteTOTPSetupChallenge(emdash.db, body.challengeId);
			return apiError(
				"INVALID_STATE",
				"Setup session expired or invalid. Please restart setup.",
				400,
			);
		}

		const result = verifyTOTPCode(keyBytes, body.code);
		if (!result.valid) {
			// Don't consume the challenge — rate limiter bounds retries.
			return apiError(
				"INVALID_TOTP_CODE",
				"Code didn't match. Check your device clock and try again.",
				400,
			);
		}

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

			if (result.usedStep !== null) {
				await adapter.updateTOTP(user.id, { lastUsedStep: result.usedStep });
			}

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

			// Mark complete last so "user exists but setup incomplete" is
			// never observable.
			await options.set("emdash:setup_complete", true);
			await deleteTOTPSetupChallenge(emdash.db, body.challengeId);
		} catch (persistError) {
			try {
				await adapter.deleteUser(user.id);
			} catch {
				/* primary error wins */
			}
			throw persistError;
		}

		// User just proved possession of the secret — safe to log them in.
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
