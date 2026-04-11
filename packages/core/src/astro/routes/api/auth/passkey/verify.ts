/**
 * POST /_emdash/api/auth/passkey/verify
 *
 * Verify a passkey authentication and create a session
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import { authenticateWithPasskey } from "@emdash-cms/auth/passkey";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { passkeyVerifyBody } from "#api/schemas.js";
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
		const body = await parseBody(request, passkeyVerifyBody);
		if (isParseError(body)) return body;

		// Get passkey config
		const url = new URL(request.url);
		const options = new OptionsRepository(emdash.db);
		const siteName = (await options.get<string>("emdash:site_title")) ?? undefined;
		const passkeyConfig = getPasskeyConfig(url, siteName, passkeyPublicOrigin);

		// Authenticate with passkey
		const adapter = createKyselyAdapter(emdash.db);
		const challengeStore = createChallengeStore(emdash.db);

		const user = await authenticateWithPasskey(
			passkeyConfig,
			adapter,
			body.credential,
			challengeStore,
		);

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
		return handleError(error, "Authentication failed", "PASSKEY_VERIFY_ERROR");
	}
};
