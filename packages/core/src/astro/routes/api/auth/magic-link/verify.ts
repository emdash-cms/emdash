/**
 * GET  /_emdash/api/auth/magic-link/verify
 * POST /_emdash/api/auth/magic-link/verify
 *
 * GET is the link in the email. It only forwards to the admin confirmation
 * page, because mail scanners fetch every link in a message and would
 * otherwise use up the single-use token before the recipient clicks.
 *
 * POST verifies the token and creates the session.
 * Tokens are single-use and expire after 15 minutes.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { verifyMagicLink, MagicLinkError } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { magicLinkVerifyBody } from "#api/schemas.js";

export const GET: APIRoute = async ({ url, redirect }) => {
	const token = url.searchParams.get("token");
	if (!token) {
		return redirect("/_emdash/admin/login?error=missing_token");
	}

	const confirmUrl = new URLSearchParams({ token });
	const rawRedirect = url.searchParams.get("redirect");
	if (rawRedirect) confirmUrl.set("redirect", rawRedirect);
	return redirect(`/_emdash/admin/login/magic-link?${confirmUrl.toString()}`);
};

export const POST: APIRoute = async ({ request, locals, session }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		const body = await parseBody(request, magicLinkVerifyBody);
		if (isParseError(body)) return body;

		const adapter = createKyselyAdapter(emdash.db);
		const user = await verifyMagicLink(adapter, body.token);

		// Fire-and-forget cleanup of expired tokens -- prevents accumulation
		void adapter.deleteExpiredTokens().catch(() => {});

		session?.set("user", { id: user.id });

		return apiSuccess({ success: true });
	} catch (error) {
		if (error instanceof MagicLinkError) {
			const statusMap: Record<MagicLinkError["code"], number> = {
				invalid_token: 400,
				token_expired: 410,
				user_not_found: 404,
				email_not_configured: 500,
			};
			return apiError(error.code.toUpperCase(), error.message, statusMap[error.code]);
		}

		return handleError(error, "Failed to verify magic link", "MAGIC_LINK_VERIFY_ERROR");
	}
};
