/**
 * POST /_emdash/api/auth/2fa/verify
 *
 * Verify a pending two-factor challenge and complete login.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { twoFactorCodeBody } from "#api/schemas.js";
import { getTwoFactorState, verifyTwoFactorCode } from "#auth/two-factor.js";

function isPendingTwoFactor(value: unknown): value is { userId: string; expiresAt: number } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- runtime checks above
	const record = value as Record<string, unknown>;
	return typeof record.userId === "string" && typeof record.expiresAt === "number";
}

export const POST: APIRoute = async ({ request, locals, session }) => {
	const { emdash } = locals;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		const body = await parseBody(request, twoFactorCodeBody);
		if (isParseError(body)) return body;

		const pendingRaw = await session?.get("pendingTwoFactor");
		if (!isPendingTwoFactor(pendingRaw) || !pendingRaw.userId) {
			return apiError("TWO_FACTOR_REQUIRED", "Two-factor verification is not pending", 401);
		}

		if (pendingRaw.expiresAt <= Date.now()) {
			return apiError("TWO_FACTOR_EXPIRED", "Two-factor challenge expired. Sign in again.", 401);
		}

		const adapter = createKyselyAdapter(emdash.db);
		const user = await adapter.getUserById(pendingRaw.userId);
		if (!user || user.disabled) {
			return apiError("NOT_AUTHENTICATED", "Sign-in session is no longer valid", 401);
		}

		const twoFactor = getTwoFactorState(user);
		if (!twoFactor.enabled || !twoFactor.secret) {
			return apiError("TWO_FACTOR_NOT_ENABLED", "Two-factor authentication is not enabled", 400);
		}

		const valid = await verifyTwoFactorCode(twoFactor.secret, body.code);
		if (!valid) {
			return apiError("INVALID_TWO_FACTOR_CODE", "Invalid verification code", 400);
		}

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
		return handleError(error, "Failed to verify two-factor code", "TWO_FACTOR_VERIFY_ERROR");
	}
};
