/**
 * POST /_emdash/api/auth/passkey/options
 *
 * Get authentication options for passkey login.
 *
 * Rate limited: 10 requests per minute per IP.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import { generateAuthenticationOptions } from "@emdash-cms/auth/passkey";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseOptionalBody } from "#api/parse.js";
import { passkeyOptionsBody } from "#api/schemas.js";
import { createChallengeStore, cleanupExpiredChallenges } from "#auth/challenge-store.js";
import { getPasskeyConfig } from "#auth/passkey-config.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "#auth/rate-limit.js";
import { OptionsRepository } from "#db/repositories/options.js";

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash } = locals;
	const passkeyPublicOrigin = emdash?.config.passkeyPublicOrigin;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		// Fire-and-forget cleanup of expired challenges -- prevents accumulation
		void cleanupExpiredChallenges(emdash.db).catch(() => {});

		// Parse body before rate limiting so malformed requests don't consume slots
		const body = await parseOptionalBody(request, passkeyOptionsBody, {});
		if (isParseError(body)) return body;

		// Rate limit: 10 requests per 60 seconds per IP
		const ip = getClientIp(request);
		const rateLimit = await checkRateLimit(emdash.db, ip, "passkey/options", 10, 60);
		if (!rateLimit.allowed) {
			return rateLimitResponse(60);
		}

		const adapter = createKyselyAdapter(emdash.db);

		// Get credentials to allow
		let credentials: Awaited<ReturnType<typeof adapter.getCredentialsByUserId>> = [];

		if (body.email) {
			// Get credentials for specific user
			const user = await adapter.getUserByEmail(body.email);
			if (user) {
				credentials = await adapter.getCredentialsByUserId(user.id);
			}
			// Don't reveal if user exists - just return empty allowCredentials
		}
		// If no email provided, allowCredentials will be undefined (allow any discoverable credential)

		// Get passkey config
		const url = new URL(request.url);
		const options = new OptionsRepository(emdash.db);
		const siteName = (await options.get<string>("emdash:site_title")) ?? undefined;
		const passkeyConfig = getPasskeyConfig(url, siteName, passkeyPublicOrigin);

		// Generate authentication options
		const challengeStore = createChallengeStore(emdash.db);
		const authOptions = await generateAuthenticationOptions(
			passkeyConfig,
			credentials,
			challengeStore,
		);

		return apiSuccess({
			success: true,
			options: authOptions,
		});
	} catch (error) {
		return handleError(error, "Failed to generate passkey options", "PASSKEY_OPTIONS_ERROR");
	}
};
