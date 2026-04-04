/**
 * GET /_emdash/api/auth/2fa/pending
 *
 * Check whether the current session has a pending two-factor challenge.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { apiError, apiSuccess } from "#api/error.js";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

function isPendingTwoFactor(value: unknown): value is { userId: string; expiresAt: number } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- runtime checks above
	const record = value as Record<string, unknown>;
	return typeof record.userId === "string" && typeof record.expiresAt === "number";
}

export const GET: APIRoute = async ({ locals, session }) => {
	const { emdash } = locals;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const sessionUser = await session?.get("user");
	if (sessionUser?.id) {
		return apiSuccess({ pending: false });
	}

	const pending = await session?.get("pendingTwoFactor");
	if (!isPendingTwoFactor(pending)) {
		return apiSuccess({ pending: false });
	}

	if (!pending.userId || pending.expiresAt <= Date.now()) {
		return apiSuccess({ pending: false });
	}

	const expiresInMs = Math.min(Math.max(pending.expiresAt - Date.now(), 0), FIVE_MINUTES_MS);
	return apiSuccess({
		pending: true,
		expiresAt: pending.expiresAt,
		expiresInMs,
	});
};
