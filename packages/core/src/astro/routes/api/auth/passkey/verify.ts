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
import { isTwoFactorEnabled } from "#auth/two-factor.js";
import { OptionsRepository } from "#db/repositories/options.js";

const TWO_FACTOR_PENDING_MS = 5 * 60 * 1000;

export const POST: APIRoute = async ({ request, locals, session }) => {
	const { emdash } = locals;

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
		const passkeyConfig = getPasskeyConfig(url, siteName);

		// Authenticate with passkey
		const adapter = createKyselyAdapter(emdash.db);
		const challengeStore = createChallengeStore(emdash.db);

		const user = await authenticateWithPasskey(
			passkeyConfig,
			adapter,
			body.credential,
			challengeStore,
		);

		if (isTwoFactorEnabled(user)) {
			if (session) {
				session.set("pendingTwoFactor", {
					userId: user.id,
					expiresAt: Date.now() + TWO_FACTOR_PENDING_MS,
				});
			}

			return apiSuccess({
				success: true,
				requiresTwoFactor: true,
			});
		}

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
