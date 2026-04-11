/**
 * POST /_emdash/api/setup/admin-totp — start first-run admin creation
 * via the authenticator-app path. Returns the otpauth URI, the base32
 * secret (for the "Can't scan?" fallback), and the plaintext recovery
 * codes. Same guards as /setup/admin.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { encryptWithHKDF } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import {
	buildOtpAuthURI,
	generateRecoveryCodes,
	generateTOTPSecret,
	hashRecoveryCode,
} from "@emdash-cms/auth/totp";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { setupAdminTotpBody } from "#api/schemas.js";
import { authSecretFailureMessage, resolveAuthSecret } from "#auth/auth-secret.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "#auth/rate-limit.js";
import { isTotpEnabled } from "#auth/totp-config.js";
import { createTOTPSetupChallenge } from "#auth/totp-setup-store.js";
import { OptionsRepository } from "#db/repositories/options.js";

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	if (!isTotpEnabled(emdash.config)) {
		return apiError("NOT_FOUND", "Not found", 404);
	}

	try {
		const ip = getClientIp(request);
		const rateLimit = await checkRateLimit(emdash.db, ip, "setup/admin-totp", 5, 15 * 60);
		if (!rateLimit.allowed) {
			return rateLimitResponse(15 * 60);
		}

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

		const body = await parseBody(request, setupAdminTotpBody);
		if (isParseError(body)) return body;

		const normalizedEmail = body.email.toLowerCase();
		const name = body.name ?? null;

		const { keyBytes, base32Secret } = generateTOTPSecret();

		const secretResult = resolveAuthSecret();
		if (!secretResult.ok) {
			console.error(`[setup/admin-totp] ${authSecretFailureMessage(secretResult.reason)}`);
			return apiError("AUTH_SECRET_MISSING", authSecretFailureMessage(secretResult.reason), 500);
		}
		const encryptedSecret = await encryptWithHKDF(base32Secret, secretResult.secret);

		const recoveryCodes = generateRecoveryCodes();
		const recoveryCodeHashes = recoveryCodes.map(hashRecoveryCode);

		const challengeId = await createTOTPSetupChallenge(emdash.db, {
			email: normalizedEmail,
			name,
			encryptedSecret,
			recoveryCodeHashes,
		});

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
