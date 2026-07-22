/**
 * Send recovery link endpoint
 *
 * POST /_emdash/api/admin/users/:id/send-recovery
 *
 * Admin-initiated account recovery — sends a recovery magic link to the user's email.
 */

import { getMagicLinkEmailStrings } from "@emdash-cms/admin/locales";
import { Role, sendMagicLink, type MagicLinkConfig } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { APIRoute } from "astro";

import { getEmailLocale } from "#api/email-locale.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { getSiteBaseUrl } from "#api/site-url.js";
import { OptionsRepository } from "#db/repositories/options.js";

export const prerender = false;

export const POST: APIRoute = async ({ request, params, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "Database not configured", 500);
	}

	if (!user || user.role < Role.ADMIN) {
		return apiError("FORBIDDEN", "Admin privileges required", 403);
	}

	const { id } = params;

	if (!id) {
		return apiError("VALIDATION_ERROR", "User ID required", 400);
	}

	try {
		const adapter = createKyselyAdapter(emdash.db);

		// Verify target user exists
		const targetUser = await adapter.getUserById(id);
		if (!targetUser) {
			return apiError("NOT_FOUND", "User not found", 404);
		}

		// Check if email pipeline is available
		if (!emdash.email?.isAvailable()) {
			return apiError(
				"EMAIL_NOT_CONFIGURED",
				"Email is not configured. Recovery links require an email provider.",
				503,
			);
		}

		// Build config using stored site URL (not request Host header)
		const options = new OptionsRepository(emdash.db);
		const baseUrl = await getSiteBaseUrl(emdash.db, request);
		const siteName = (await options.get<string>("emdash:site_title")) ?? "EmDash";

		// Localized copy following the site locale (#915); the locale also
		// drives lang/dir on the email HTML so RTL copy renders correctly.
		const emailLocale = await getEmailLocale(emdash.db, request);
		const config: MagicLinkConfig = {
			baseUrl,
			siteName,
			email: (message) => emdash.email!.send(message, "system"),
			emailStrings: await getMagicLinkEmailStrings(emailLocale, siteName),
			emailLocale,
		};

		// Send recovery link
		await sendMagicLink(config, adapter, targetUser.email, "recovery");

		return apiSuccess({ success: true, message: "Recovery link sent" });
	} catch (error) {
		return handleError(error, "Failed to send recovery link", "RECOVERY_SEND_ERROR");
	}
};
