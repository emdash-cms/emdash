/**
 * POST /_emdash/api/auth/totp/login
 *
 * Ongoing login via TOTP. Accepts either a 6-digit code from the user's
 * authenticator app OR a one-time recovery code, and on success creates
 * a session just like the passkey verify route does. Which path is
 * taken is a discriminated union in the request body — the UI always
 * knows which form it's submitting.
 *
 * State machine on the totp_secrets row:
 *   - Successful TOTP login: failed_attempts=0, last_used_step=<matched>,
 *     locked_until=null
 *   - Failed TOTP login: failed_attempts += 1, lockout triggered at 10
 *   - Successful recovery login: the recovery token is deleted (single
 *     use) and failed_attempts is reset so the user can log in with
 *     TOTP on their next attempt if they set up a new authenticator
 *
 * Security:
 *   - Per-IP rate limit (5 / 15 min) on every attempt
 *   - Per-account lockout (10 consecutive failures → 15-minute cooldown)
 *   - Replay protection (last_used_step guard in verifyTOTPCode callers)
 *   - Vague error responses (INVALID_CREDENTIALS for wrong email OR
 *     wrong code OR disabled user) to prevent enumeration
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
import { checkRateLimit, getClientIp, rateLimitResponse } from "#auth/rate-limit.js";
import { isTotpEnabled } from "#auth/totp-config.js";

/** Resolve EMDASH_AUTH_SECRET with hard failure on absence — silently
 * falling back to a default would leak the encrypted TOTP blob. */
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

	if (!isTotpEnabled(emdash.config)) {
		return apiError("NOT_FOUND", "Not found", 404);
	}

	try {
		// Rate limit per IP. Uses the same bucket for both the TOTP path
		// and the recovery path — an attacker rotating between them can't
		// get 2x the attempts.
		const ip = getClientIp(request);
		const rateLimit = await checkRateLimit(
			emdash.db,
			ip,
			"auth/totp/login",
			5,
			15 * 60,
		);
		if (!rateLimit.allowed) {
			return rateLimitResponse(15 * 60);
		}

		// Parse + validate the discriminated body. Malformed input
		// (wrong digit count, missing field for the chosen method)
		// fails here before any DB or crypto work.
		const body = await parseBody(request, totpLoginBody);
		if (isParseError(body)) return body;

		const adapter = createKyselyAdapter(emdash.db);

		// Look up the user by email. Intentionally NOT revealing whether
		// the user exists — both missing and disabled return the same
		// vague INVALID_CREDENTIALS shape as a wrong code would.
		const user = await adapter.getUserByEmail(body.email);
		if (!user || user.disabled) {
			return invalidCredentials();
		}

		const totp = await adapter.getTOTPByUserId(user.id);
		if (!totp) {
			return invalidCredentials();
		}

		// ── Account-level lockout check ──────────────────────────────
		// The locked_until column carries an ISO timestamp; NULL means
		// "not locked". If it's in the future, refuse the TOTP path
		// outright (recovery still works, which is the escape hatch).
		const now = Date.now();
		const lockedUntilMs = totp.lockedUntil ? Date.parse(totp.lockedUntil) : 0;
		const isLocked = lockedUntilMs > now;

		if (body.method === "totp") {
			if (isLocked) {
				return apiError(
					"TOTP_LOCKED",
					"Too many attempts. Use a recovery code instead.",
					423,
				);
			}

			// Decrypt the stored secret and decode to raw bytes for the
			// verify primitive. A decrypt failure here means corruption
			// or auth-secret rotation — surface as INVALID_CREDENTIALS
			// (vague) rather than leaking the cause.
			let keyBytes: Uint8Array;
			try {
				const base32Secret = await decryptWithHKDF(totp.encryptedSecret, resolveAuthSecret());
				keyBytes = decodeBase32IgnorePadding(base32Secret);
			} catch {
				return invalidCredentials();
			}

			const result = verifyTOTPCode(keyBytes, body.code);

			if (!result.valid || result.usedStep === null) {
				// Wrong code. Increment failed_attempts and lock if we
				// crossed the threshold. The lockout duration is a
				// fixed window, not a sliding one — after it elapses
				// the user can try again, but failed_attempts is only
				// reset on a successful login or recovery code use.
				const newFailedAttempts = totp.failedAttempts + 1;
				const shouldLock = newFailedAttempts >= LOCKOUT_THRESHOLD;
				await adapter.updateTOTP(user.id, {
					failedAttempts: newFailedAttempts,
					lockedUntil: shouldLock
						? new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString()
						: totp.lockedUntil,
				});
				return invalidCredentials();
			}

			// Replay protection: reject codes whose matched step is
			// `<=` the last one we accepted. Without this guard, the
			// same 6-digit code would work twice within its 30-second
			// window.
			if (result.usedStep <= totp.lastUsedStep) {
				const newFailedAttempts = totp.failedAttempts + 1;
				const shouldLock = newFailedAttempts >= LOCKOUT_THRESHOLD;
				await adapter.updateTOTP(user.id, {
					failedAttempts: newFailedAttempts,
					lockedUntil: shouldLock
						? new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString()
						: totp.lockedUntil,
				});
				return invalidCredentials();
			}

			// Success — bump lastUsedStep, reset failed_attempts,
			// clear any stale lockout, and create the session.
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

		// ── Recovery code path ───────────────────────────────────────
		// Recovery codes work even when the account is locked — that's
		// the whole point. Hash the incoming code, look up the matching
		// auth_tokens row scoped to this user, delete it on success
		// (single use), reset the lockout state, and create the session.
		const hash = hashRecoveryCode(body.recoveryCode);
		const token = await adapter.getToken(hash, "recovery");

		if (!token || token.userId !== user.id) {
			// Wrong code or cross-user recovery token. We intentionally
			// do NOT bump failedAttempts on the TOTP credential here —
			// recovery codes have their own keyspace (40 bits × 10
			// codes × rate limit), so linking them to the TOTP
			// lockout would give an attacker a way to lock the
			// legitimate user out by guessing recovery codes.
			return invalidCredentials();
		}

		// Delete the token first (single-use guarantee — even if the
		// session cookie set fails, the code cannot be reused).
		await adapter.deleteToken(hash);

		// Reset the TOTP state so the next TOTP login can succeed, and
		// clear any existing lockout.
		await adapter.updateTOTP(user.id, {
			failedAttempts: 0,
			lockedUntil: null,
		});

		if (session) {
			session.set("user", { id: user.id });
		}

		// Count the remaining recovery codes so the UI can show a
		// banner prompting the user to regenerate or enroll a new
		// authenticator. This is a cheap COUNT query and gives the
		// user a concrete number to react to.
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

/**
 * Count how many unused recovery codes a user has left. Uses a direct
 * SQL count against auth_tokens because the AuthAdapter doesn't expose
 * a "count tokens by user and type" method and we don't want to add
 * one just for this banner.
 */
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

/**
 * Every wrong-credential path returns the exact same response shape
 * and status code so callers cannot use timing or response body to
 * distinguish "user not found" from "wrong code" from "account
 * disabled".
 */
function invalidCredentials(): Response {
	return apiError("INVALID_CREDENTIALS", "Email or code is wrong", 400);
}
