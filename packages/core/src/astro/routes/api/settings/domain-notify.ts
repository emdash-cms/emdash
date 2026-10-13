/**
 * POST /_emdash/api/settings/domain/notify
 *
 * Emails every active user except the sender that the site now lives at
 * its chosen address (the configured `siteUrl`, otherwise the Site URL),
 * with a link to the sign-in page there. The email carries no sign-in token.
 * Sites that sign in through an external provider are refused.
 */

import { getDomainMoveEmailStrings } from "@emdash-cms/admin/locales/emails";
import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { resolveEmailLocale } from "#api/email-locale.js";
import { apiError, handleError, unwrapResult } from "#api/error.js";
import { handleDomainMoveNotice } from "#api/handlers/domain-move-notice.js";
import { getChosenSiteOrigin } from "#api/site-url.js";
import { getAuthMode } from "#auth/mode.js";
import { checkRateLimit } from "#auth/rate-limit.js";
import { OptionsRepository } from "#db/repositories/options.js";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	if (!user) return apiError("NOT_AUTHENTICATED", "Not authenticated", 401);
	const denied = requirePerm(user, "users:manage");
	if (denied) return denied;
	if (locals.tokenScopes !== undefined) {
		return apiError("FORBIDDEN", "Emailing users requires a signed-in session", 403);
	}
	if (getAuthMode(emdash.config).type !== "passkey") {
		return apiError("NOT_SUPPORTED", "Users sign in through an external provider", 400);
	}

	if (!emdash.email?.isAvailable()) {
		return apiError(
			"EMAIL_NOT_CONFIGURED",
			"No email provider is configured. Install and activate an email provider plugin.",
			503,
		);
	}

	try {
		const origin = await getChosenSiteOrigin(emdash.db, emdash.config);
		if (!origin) {
			return apiError("NO_SITE_URL", "Set a Site URL before emailing users about it", 409);
		}

		const rateLimit = await checkRateLimit(emdash.db, "site", "settings/domain/notify", 3, 3600);
		if (!rateLimit.allowed) {
			return apiError("RATE_LIMITED", "Users were emailed recently. Try again later.", 429);
		}

		const options = new OptionsRepository(emdash.db);
		const siteOptions = await options.getMany<string>(["emdash:site_title", "emdash:locale"]);
		const siteName = siteOptions.get("emdash:site_title") || "EmDash";
		const locale = resolveEmailLocale(siteOptions.get("emdash:locale"), request);
		const email = emdash.email;

		const result = await handleDomainMoveNotice(emdash.db, {
			origin,
			strings: await getDomainMoveEmailStrings(locale, siteName, new URL(origin).host),
			locale,
			senderId: user.id,
			send: (message) => email.send(message, "system"),
		});
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to email users", "DOMAIN_MOVE_NOTICE_ERROR");
	}
};
