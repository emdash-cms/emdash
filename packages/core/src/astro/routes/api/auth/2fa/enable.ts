/**
 * POST /_emdash/api/auth/2fa/enable
 *
 * Enable two-factor authentication after validating an authenticator code.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { twoFactorCodeBody } from "#api/schemas.js";
import { enableTwoFactor, getTwoFactorState, verifyTwoFactorCode } from "#auth/two-factor.js";

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	if (!user) {
		return apiError("NOT_AUTHENTICATED", "Not authenticated", 401);
	}

	try {
		const body = await parseBody(request, twoFactorCodeBody);
		if (isParseError(body)) return body;

		const adapter = createKyselyAdapter(emdash.db);
		const freshUser = await adapter.getUserById(user.id);
		if (!freshUser) {
			return apiError("NOT_AUTHENTICATED", "Not authenticated", 401);
		}

		const twoFactor = getTwoFactorState(freshUser);
		if (!twoFactor.pendingSecret) {
			return apiError(
				"TWO_FACTOR_NOT_SETUP",
				"No pending two-factor setup found. Start setup first.",
				400,
			);
		}

		const valid = await verifyTwoFactorCode(twoFactor.pendingSecret, body.code);
		if (!valid) {
			return apiError("INVALID_TWO_FACTOR_CODE", "Invalid verification code", 400);
		}

		const nextData = enableTwoFactor(freshUser.data, twoFactor.pendingSecret);
		await adapter.updateUser(freshUser.id, { data: nextData });

		return apiSuccess({ success: true, enabled: true });
	} catch (error) {
		return handleError(error, "Failed to enable two-factor", "TWO_FACTOR_ENABLE_ERROR");
	}
};
