/**
 * GET /_emdash/api/auth/me
 *
 * Returns the current authenticated user's info.
 * Used by the admin UI to display user info in the header.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { authMeActionBody } from "#api/schemas.js";
import { UserRepository } from "#db/repositories/user.js";

export const GET: APIRoute = async ({ locals }) => {
	const { user } = locals;

	if (!user) {
		return apiError("NOT_AUTHENTICATED", "Not authenticated", 401);
	}

	// Check if this is the user's first login (for welcome modal).
	// The flag is persisted in the user's `data` JSON column so it survives
	// session expiry / rotation.
	const isFirstLogin = !user.data?.welcomeDismissed;

	// Return safe user info (no sensitive data)
	return apiSuccess({
		id: user.id,
		email: user.email,
		name: user.name,
		role: user.role,
		avatarUrl: user.avatarUrl,
		isFirstLogin,
	});
};

/**
 * POST /_emdash/api/auth/me
 *
 * Mark that the user has seen the welcome modal.
 */
export const POST: APIRoute = async ({ request, locals }) => {
	const { user, emdash } = locals;

	if (!user) {
		return apiError("NOT_AUTHENTICATED", "Not authenticated", 401);
	}

	if (!emdash) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

	const body = await parseBody(request, authMeActionBody);
	if (isParseError(body)) return body;

	if (body.action === "dismissWelcome") {
		try {
			// Persist in the user's data column so it survives session expiry.
			const userRepo = new UserRepository(emdash.db);
			await userRepo.update(user.id, {
				data: { ...user.data, welcomeDismissed: true },
			});
			return apiSuccess({ success: true });
		} catch (error) {
			return handleError(error, "Failed to dismiss welcome", "WELCOME_DISMISS_ERROR");
		}
	}

	return apiError("UNKNOWN_ACTION", "Unknown action", 400);
};
