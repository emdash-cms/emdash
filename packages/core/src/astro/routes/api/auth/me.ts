/**
 * GET /_emdash/api/auth/me
 *
 * Returns the current authenticated user's info.
 * Used by the admin UI to display user info in the header.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { apiError, apiSuccess } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { authMeActionBody, updateProfileBody } from "#api/schemas.js";
import { UserRepository } from "#db/repositories/user.js";

export const GET: APIRoute = async ({ locals, session }) => {
	const { user } = locals;

	if (!user) {
		return apiError("NOT_AUTHENTICATED", "Not authenticated", 401);
	}

	// Check if this is the user's first login (for welcome modal)
	// We track this in the session to show the modal only once
	const hasSeenWelcome = await session?.get("hasSeenWelcome");
	const isFirstLogin = !hasSeenWelcome;

	// Return safe user info (no sensitive data)
	return apiSuccess({
		id: user.id,
		email: user.email,
		name: user.name,
		role: user.role,
		avatarUrl: user.avatarUrl,
		data: user.data,
		isFirstLogin,
	});
};

/**
 * POST /_emdash/api/auth/me
 *
 * Mark that the user has seen the welcome modal.
 */
export const POST: APIRoute = async ({ request, locals, session }) => {
	const { user } = locals;

	if (!user) {
		return apiError("NOT_AUTHENTICATED", "Not authenticated", 401);
	}

	const body = await parseBody(request, authMeActionBody);
	if (isParseError(body)) return body;

	if (body.action === "dismissWelcome") {
		session?.set("hasSeenWelcome", true);
		return apiSuccess({ success: true });
	}

	return apiError("UNKNOWN_ACTION", "Unknown action", 400);
};

/**
 * PUT /_emdash/api/auth/me
 *
 * Update the current user's profile (name, avatarUrl).
 */
export const PUT: APIRoute = async ({ request, locals }) => {
	const { user } = locals;

	if (!user) {
		return apiError("NOT_AUTHENTICATED", "Not authenticated", 401);
	}

	const emdash = locals.emdash;
	if (!emdash?.db) {
		return apiError("SERVICE_UNAVAILABLE", "Database not available", 503);
	}

	const body = await parseBody(request, updateProfileBody);
	if (isParseError(body)) return body;

	const userRepo = new UserRepository(emdash.db);

	// Merge data: preserve existing keys, allow overwriting individual keys
	let mergedData: Record<string, unknown> | undefined;
	if (body.data !== undefined) {
		if (body.data === null) {
			mergedData = {};
		} else {
			const existing = (await userRepo.findById(user.id))?.data ?? {};
			mergedData = { ...existing, ...body.data };
		}
	}

	const updated = await userRepo.update(user.id, {
		name: body.name ?? undefined,
		avatarUrl: body.avatarUrl ?? undefined,
		data: mergedData,
	});

	if (!updated) {
		return apiError("NOT_FOUND", "User not found", 404);
	}

	return apiSuccess({
		id: updated.id,
		email: updated.email,
		name: updated.name,
		role: updated.role,
		avatarUrl: updated.avatarUrl,
		data: updated.data,
	});
};
