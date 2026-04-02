/**
 * GET /_emdash/api/auth/2fa/status
 *
 * Returns two-factor status for the current authenticated user.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { getTwoFactorState } from "#auth/two-factor.js";

export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	if (!user) {
		return apiError("NOT_AUTHENTICATED", "Not authenticated", 401);
	}

	try {
		const adapter = createKyselyAdapter(emdash.db);
		const freshUser = await adapter.getUserById(user.id);
		if (!freshUser) {
			return apiError("NOT_AUTHENTICATED", "Not authenticated", 401);
		}

		const twoFactor = getTwoFactorState(freshUser);
		return apiSuccess({
			enabled: twoFactor.enabled && !!twoFactor.secret,
			hasPendingSetup: !!twoFactor.pendingSecret,
			enabledAt: twoFactor.enabledAt ?? null,
		});
	} catch (error) {
		return handleError(error, "Failed to fetch two-factor status", "TWO_FACTOR_STATUS_ERROR");
	}
};
