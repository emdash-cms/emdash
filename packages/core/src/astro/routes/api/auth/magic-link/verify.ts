/**
 * GET /_emdash/api/auth/magic-link/verify
 *
 * Verify a magic link token and create a session.
 * Tokens are single-use and expire after 15 minutes.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { verifyMagicLink, AccountDisabledError, MagicLinkError } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";

import { apiError } from "#api/error.js";
import { isSafeRedirect } from "#api/redirect.js";

export const GET: APIRoute = async ({ url, locals, session, redirect }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	// Get token from query params
	const token = url.searchParams.get("token");

	if (!token) {
		// Redirect to login with error
		return redirect("/_emdash/admin/login?error=missing_token");
	}

	try {
		// Verify the magic link token
		const adapter = createKyselyAdapter(emdash.db);
		const user = await verifyMagicLink(adapter, token);

		// Fire-and-forget cleanup of expired tokens -- prevents accumulation
		void adapter.deleteExpiredTokens().catch(() => {});

		// Create session
		if (session) {
			session.set("user", { id: user.id });
		}

		// Check for a stored redirect URL (from original request)
		// Validate redirect is a safe local path (prevent open redirect via //evil.com or /\evil.com)
		const rawRedirect = url.searchParams.get("redirect");
		const redirectUrl = isSafeRedirect(rawRedirect) ? rawRedirect : "/_emdash/admin";

		// Redirect to admin dashboard or original URL
		return redirect(redirectUrl);
	} catch (error) {
		console.error("Magic link verify error:", error);

		if (error instanceof AccountDisabledError) {
			return redirect(
				`/_emdash/admin/login?error=${error.code}&message=${encodeURIComponent(error.message)}`,
			);
		}

		// Handle specific errors
		if (error instanceof MagicLinkError) {
			switch (error.code) {
				case "invalid_token":
					return redirect("/_emdash/admin/login?error=invalid_link");
				case "token_expired":
					return redirect("/_emdash/admin/login?error=link_expired");
				case "user_not_found":
					return redirect("/_emdash/admin/login?error=user_not_found");
			}
		}

		// Generic error
		return redirect("/_emdash/admin/login?error=verification_failed");
	}
};
