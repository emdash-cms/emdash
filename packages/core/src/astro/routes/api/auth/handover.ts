/**
 * POST /_emdash/api/auth/handover
 *
 * Returns a single-use sign-in link for the current user at the site's
 * chosen address: the configured `siteUrl`, otherwise the **Site URL**.
 * After a domain change, passkeys created on the old address don't work on
 * the new one, so this is how a signed-in user moves their session there.
 * The link expires after 5 minutes and opens Security settings ready to add
 * a passkey.
 *
 * Signed-in sessions only: bearer tokens are refused.
 */

import { createMagicLinkUrl } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { APIRoute } from "astro";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { getChosenSiteOrigin } from "#api/site-url.js";
import { checkRateLimit } from "#auth/rate-limit.js";

export const prerender = false;

const HANDOVER_EXPIRY_MS = 5 * 60 * 1000;
const HANDOVER_REDIRECT = "/_emdash/admin/settings/security?addPasskey=1";

export const POST: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	if (!user) {
		return apiError("NOT_AUTHENTICATED", "Not authenticated", 401);
	}
	if (locals.tokenScopes !== undefined) {
		return apiError("FORBIDDEN", "Sign-in handover requires a signed-in session", 403);
	}

	try {
		const rateLimit = await checkRateLimit(emdash.db, user.id, "auth/handover", 5, 300);
		if (!rateLimit.allowed) {
			return apiError("RATE_LIMITED", "Too many sign-in links. Try again in a few minutes.", 429);
		}

		const origin = await getChosenSiteOrigin(emdash.db, emdash.config);
		if (!origin) {
			return apiError("NO_SITE_URL", "Set a Site URL before continuing at another address", 409);
		}

		const url = await createMagicLinkUrl(createKyselyAdapter(emdash.db), user, origin, {
			expiresInMs: HANDOVER_EXPIRY_MS,
			redirect: HANDOVER_REDIRECT,
		});
		return apiSuccess({ url });
	} catch (error) {
		return handleError(error, "Failed to create a sign-in link", "SIGN_IN_HANDOVER_ERROR");
	}
};
