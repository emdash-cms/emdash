/**
 * POST /_emdash/api/auth/atproto/login
 *
 * Initiates ATProto OAuth login flow.
 * Accepts a Bluesky handle, resolves it to a PDS, generates PKCE state,
 * and returns the authorization URL for the user to be redirected to.
 */

import type { APIRoute } from "astro";

import { apiError, handleError } from "#api/error.js";
import { createAtprotoClient } from "#auth/atproto/client.js";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	if (!emdash.config?.atproto) {
		return apiError("NOT_CONFIGURED", "ATProto authentication is not enabled", 403);
	}

	let handle: string;
	try {
		const body = (await request.json()) as { handle?: string };
		handle = typeof body.handle === "string" ? body.handle.trim().toLowerCase() : "";
	} catch {
		return apiError("VALIDATION_ERROR", "Invalid request body", 400);
	}

	if (!handle || !handle.includes(".")) {
		return apiError(
			"VALIDATION_ERROR",
			"Please enter a valid handle (e.g., alice.bsky.social)",
			400,
		);
	}

	try {
		const url = new URL(request.url);
		const client = createAtprotoClient({
			publicUrl: url.origin,
			db: emdash.db,
			allowHttp: import.meta.env.DEV,
		});

		const authUrl = await client.authorize(handle);

		return Response.json({ data: { redirectUrl: authUrl.toString() } });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		console.error("[ATPROTO_LOGIN_ERROR]", message);
		return apiError("ATPROTO_LOGIN_ERROR", "Failed to initiate ATProto login", 500);
	}
};
