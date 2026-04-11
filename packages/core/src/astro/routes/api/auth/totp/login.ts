/**
 * POST /_emdash/api/auth/totp/login — ongoing login via authenticator
 * app OR single-use recovery code. Returns the same INVALID_CREDENTIALS
 * shape for every wrong-credential path so response body + timing can't
 * distinguish "user missing" from "wrong code" from "disabled".
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { decryptWithHKDF } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import {
	LOCKOUT_DURATION_MS,
	LOCKOUT_THRESHOLD,
	hashRecoveryCode,
	verifyTOTPCode,
} from "@emdash-cms/auth/totp";
import { decodeBase32IgnorePadding } from "@oslojs/encoding";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { totpLoginBody } from "#api/schemas.js";
import { authSecretFailureMessage, resolveAuthSecret } from "#auth/auth-secret.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "#auth/rate-limit.js";
import { isTotpEnabled } from "#auth/totp-config.js";

export const POST: APIRoute = async ({ request, locals, session }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	if (!isTotpEnabled(emdash.config)) {
		return apiError("NOT_FOUND", "Not found", 404);
	}

	try {
		const body = await parseBody(request, totpLoginBody);
		if (isParseError(body)) return body;

		// Separate rate-limit buckets per method so a user who typos
		// their TOTP code 5 times can still reach for a recovery code
		// without waiting 15 minutes — the recovery path is the
		// escape hatch and must not be throttled by the primary one.
		const ip = getClientIp(request);
		const rateLimit = await checkRateLimit(
			emdash.db,
			ip,
			`auth/totp/login:${body.method}`,
			5,
			15 * 60,
		);
		if (!rateLimit.allowed) {
			return rateLimitResponse(15 * 60);
		}

		const adapter = createKyselyAdapter(emdash.db);

		const user = await adapter.getUserByEmail(body.email);
		if (!user || user.disabled) {
			return invalidCredentials();
		}

		const totp = await adapter.getTOTPByUserId(user.id);
		if (!totp) {
			return invalidCredentials();
		}

		const now = Date.now();
		const lockedUntilMs = totp.lockedUntil ? Date.parse(totp.lockedUntil) : 0;
		const isLocked = lockedUntilMs > now;

		// Lockout expired since last write — reset the counter so the
		// next wrong code starts a fresh 10-attempt budget instead of
		// immediately re-locking.
		const lockoutJustExpired = totp.lockedUntil !== null && !isLocked;
		const baseFailedAttempts = lockoutJustExpired ? 0 : totp.failedAttempts;
		const baseLockedUntil = lockoutJustExpired ? null : totp.lockedUntil;

		if (body.method === "totp") {
			if (isLocked) {
				// Match invalidCredentials exactly so response body + status
				// don't distinguish locked from wrong-code from user-missing.
				return invalidCredentials();
			}

			const secretResult = resolveAuthSecret();
			if (!secretResult.ok) {
				console.error(
					`[auth/totp/login] ${authSecretFailureMessage(secretResult.reason)}`,
				);
				return apiError(
					"AUTH_SECRET_MISSING",
					authSecretFailureMessage(secretResult.reason),
					500,
				);
			}
			let keyBytes: Uint8Array;
			try {
				const base32Secret = await decryptWithHKDF(totp.encryptedSecret, secretResult.secret);
				keyBytes = decodeBase32IgnorePadding(base32Secret);
			} catch {
				return invalidCredentials();
			}

			const result = verifyTOTPCode(keyBytes, body.code);

			// Replay: reject any code whose matched step is <= lastUsedStep.
			const isReplay =
				result.valid && result.usedStep !== null && result.usedStep <= totp.lastUsedStep;
			if (!result.valid || result.usedStep === null || isReplay) {
				const newFailedAttempts = baseFailedAttempts + 1;
				const shouldLock = newFailedAttempts >= LOCKOUT_THRESHOLD;
				await adapter.updateTOTP(user.id, {
					failedAttempts: newFailedAttempts,
					lockedUntil: shouldLock
						? new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString()
						: baseLockedUntil,
				});
				return invalidCredentials();
			}

			await adapter.updateTOTP(user.id, {
				lastUsedStep: result.usedStep,
				failedAttempts: 0,
				lockedUntil: null,
			});

			if (session) {
				session.set("user", { id: user.id });
			}

			return apiSuccess({
				success: true,
				user: { id: user.id, email: user.email, name: user.name, role: user.role },
			});
		}

		// Recovery path — works even while locked (it's the escape hatch).
		// Not gated by failedAttempts so guessing recovery codes can't DoS a legit user.
		const hash = hashRecoveryCode(body.recoveryCode);
		const token = await adapter.getToken(hash, "recovery");

		if (!token || token.userId !== user.id) {
			return invalidCredentials();
		}

		// Delete first — single-use guarantee holds even if the session
		// cookie set fails afterwards.
		await adapter.deleteToken(hash);
		await adapter.updateTOTP(user.id, {
			failedAttempts: 0,
			lockedUntil: null,
		});

		if (session) {
			session.set("user", { id: user.id });
		}

		const remainingRecoveryCodes = await countRemainingRecoveryCodes(emdash.db, user.id);

		return apiSuccess({
			success: true,
			user: { id: user.id, email: user.email, name: user.name, role: user.role },
			remainingRecoveryCodes,
		});
	} catch (error) {
		return handleError(error, "TOTP login failed", "TOTP_LOGIN_ERROR");
	}
};

async function countRemainingRecoveryCodes(
	db: NonNullable<App.Locals["emdash"]>["db"],
	userId: string,
): Promise<number> {
	const result = await db
		.selectFrom("auth_tokens")
		.select((eb) => eb.fn.countAll<number>().as("count"))
		.where("user_id", "=", userId)
		.where("type", "=", "recovery")
		.executeTakeFirstOrThrow();
	return Number(result.count);
}

/** Uniform shape for every wrong-credential path to block enumeration. */
function invalidCredentials(): Response {
	return apiError("INVALID_CREDENTIALS", "Email or code is wrong", 400);
}
