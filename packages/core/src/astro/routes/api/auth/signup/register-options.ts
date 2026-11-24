export const prerender = false;

import { validateSignupToken, SignupError } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import { generateRegistrationOptions } from "@emdash-cms/auth/passkey";
import type { APIRoute } from "astro";
import { ulid } from "ulidx";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { getPublicOrigin } from "#api/public-url.js";
import { signupRegisterOptionsBody } from "#api/schemas.js";
import { getSiteTitle } from "#api/site-title.js";
import { createChallengeStore } from "#auth/challenge-store.js";
import { getPasskeyConfig } from "#auth/passkey-config.js";
import { OptionsRepository } from "#db/repositories/options.js";

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		const body = await parseBody(request, signupRegisterOptionsBody);
		if (isParseError(body)) return body;

		const adapter = createKyselyAdapter(emdash.db);
		const signup = await validateSignupToken(adapter, body.token);

		const url = new URL(request.url);
		const options = new OptionsRepository(emdash.db);
		const siteName = await getSiteTitle(options);
		const siteUrl = getPublicOrigin(url, emdash.config);
		const passkeyConfig = getPasskeyConfig(url, siteName, siteUrl);

		const challengeStore = createChallengeStore(emdash.db);
		const tempUser = {
			id: ulid(),
			email: signup.email,
			name: body.name || null,
		};
		const registrationOptions = await generateRegistrationOptions(
			passkeyConfig,
			tempUser,
			[],
			challengeStore,
		);

		return apiSuccess({ options: registrationOptions });
	} catch (error) {
		if (error instanceof SignupError) {
			const statusMap: Record<string, number> = {
				invalid_token: 404,
				token_expired: 410,
				user_exists: 409,
				domain_not_allowed: 403,
			};
			return apiError(error.code.toUpperCase(), error.message, statusMap[error.code] ?? 400);
		}

		return handleError(
			error,
			"Failed to generate registration options",
			"SIGNUP_REGISTER_OPTIONS_ERROR",
		);
	}
};
