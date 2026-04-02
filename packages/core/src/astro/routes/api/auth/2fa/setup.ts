/**
 * POST /_emdash/api/auth/2fa/setup
 *
 * Generate a new two-factor secret for the authenticated user.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import {
	buildOtpAuthUrl,
	generateTwoFactorSecret,
	setTwoFactorPendingSecret,
} from "#auth/two-factor.js";
import { OptionsRepository } from "#db/repositories/options.js";

export const POST: APIRoute = async ({ locals }) => {
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

		const secret = generateTwoFactorSecret();
		const nextData = setTwoFactorPendingSecret(freshUser.data, secret);
		await adapter.updateUser(freshUser.id, { data: nextData });

		const options = new OptionsRepository(emdash.db);
		const siteTitle = (await options.get<string>("emdash:site_title")) ?? "EmDash";
		const otpAuthUrl = buildOtpAuthUrl(secret, freshUser.email, siteTitle);

		return apiSuccess({
			secret,
			otpAuthUrl,
		});
	} catch (error) {
		return handleError(error, "Failed to initialize two-factor setup", "TWO_FACTOR_SETUP_ERROR");
	}
};
