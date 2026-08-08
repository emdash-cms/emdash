/**
 * POST /_emdash/api/auth/invite
 *
 * Create an invite for a new user. Admin only.
 *
 * When an email provider is configured (via the plugin email pipeline),
 * the invite email is sent automatically.
 * When no provider is configured, returns the invite URL for the admin
 * to share manually (copy-link fallback).
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { getInviteEmailStrings } from "@emdash-cms/admin/locales";
import { createInvite, InviteError, Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";

import { getEmailLocale } from "#api/email-locale.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { inviteCreateBody } from "#api/schemas.js";
import { getSiteBaseUrl } from "#api/site-url.js";
import { OptionsRepository } from "#db/repositories/options.js";

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	if (!user || user.role < Role.ADMIN) {
		return apiError("FORBIDDEN", "Admin privileges required", 403);
	}

	const adapter = createKyselyAdapter(emdash.db);

	try {
		const body = await parseBody(request, inviteCreateBody);
		if (isParseError(body)) return body;

		// Default to AUTHOR role if not specified (Zod validates the level)
		const role = body.role ?? Role.AUTHOR;

		// Get site config for invite email
		const options = new OptionsRepository(emdash.db);
		const siteName = (await options.get<string>("emdash:site_title")) || "EmDash";

		// Use stored site URL to prevent Host header spoofing in invite emails
		const baseUrl = await getSiteBaseUrl(emdash.db, request);

		// Build email sender from the plugin pipeline (if available)
		const emailSend = emdash.email?.isAvailable()
			? (message: { to: string; subject: string; text: string; html?: string }) =>
					emdash.email!.send(message, "system")
			: undefined;

		// Localize the invite email copy (#915). Only resolved when an
		// email will actually be sent — the copy-link fallback has no copy.
		const emailLocale = emailSend ? await getEmailLocale(emdash.db, request) : undefined;
		const emailStrings = emailLocale
			? await getInviteEmailStrings(emailLocale, siteName)
			: undefined;

		const result = await createInvite(
			{
				baseUrl,
				siteName,
				email: emailSend,
				emailStrings,
				emailLocale,
			},
			adapter,
			body.email,
			role,
			user.id,
		);

		if (emailSend) {
			// Email was sent
			return apiSuccess({
				success: true,
				message: `Invite sent to ${body.email}`,
			});
		}

		// No email provider — return the invite URL for manual sharing
		return apiSuccess(
			{
				success: true,
				message: "Invite created. No email provider configured — share the link manually.",
				inviteUrl: result.url,
			},
			200,
		);
	} catch (error) {
		if (error instanceof InviteError) {
			const statusMap: Record<string, number> = {
				user_exists: 409,
				invalid_token: 400,
				token_expired: 400,
			};
			return apiError(error.code.toUpperCase(), error.message, statusMap[error.code] ?? 400);
		}

		return handleError(error, "Failed to create invite", "INVITE_CREATE_ERROR");
	}
};
