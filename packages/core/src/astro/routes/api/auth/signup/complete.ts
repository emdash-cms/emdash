/**
 * POST /_emdash/api/auth/signup/complete
 *
 * Complete self-signup by registering a passkey for the new user.
 * This creates the user account and establishes a session.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { completeSignup, SignupError } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import { verifyRegistrationResponse, registerPasskey } from "@emdash-cms/auth/passkey";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { signupCompleteBody } from "#api/schemas.js";
import { createChallengeStore } from "#auth/challenge-store.js";
import { getPasskeyConfig } from "#auth/passkey-config.js";
import { OptionsRepository } from "#db/repositories/options.js";

export const POST: APIRoute = async ({ request, locals, session }) => {
	const { emdash } = locals;
	const passkeyPublicOrigin = emdash?.config.passkeyPublicOrigin;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		const body = await parseBody(request, signupCompleteBody);
		if (isParseError(body)) return body;

		const adapter = createKyselyAdapter(emdash.db);

		// Get passkey config
		const url = new URL(request.url);
		const options = new OptionsRepository(emdash.db);
		const siteName = (await options.get<string>("emdash:site_title")) ?? undefined;
		const passkeyConfig = getPasskeyConfig(url, siteName, passkeyPublicOrigin);

		// Verify the passkey registration response
		const challengeStore = createChallengeStore(emdash.db);
		const verified = await verifyRegistrationResponse(
			passkeyConfig,
			body.credential,
			challengeStore,
		);

		// Complete the signup - creates the user
		const user = await completeSignup(adapter, body.token, {
			name: body.name,
		});

		// Register the passkey for the new user
		await registerPasskey(adapter, user.id, verified, "Initial passkey");

		// Create session
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
		if (error instanceof SignupError) {
			const statusMap: Record<string, number> = {
				invalid_token: 404,
				token_expired: 410,
				user_exists: 409,
				domain_not_allowed: 403,
			};
			return apiError(error.code.toUpperCase(), error.message, statusMap[error.code] ?? 400);
		}

		return handleError(error, "Failed to complete signup", "SIGNUP_COMPLETE_ERROR");
	}
};
