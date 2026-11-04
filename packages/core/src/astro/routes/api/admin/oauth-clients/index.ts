/**
 * OAuth client management endpoints
 *
 * GET  /_emdash/api/admin/oauth-clients — List all registered OAuth clients
 * POST /_emdash/api/admin/oauth-clients — Register a new OAuth client
 */

import { Role } from "@emdash-cms/auth";
import type { APIRoute } from "astro";
import { z } from "zod";

import { apiError, handleError, unwrapResult } from "#api/error.js";
import { handleOAuthClientCreate, handleOAuthClientList } from "#api/handlers/oauth-clients.js";
import { isParseError, parseBody } from "#api/parse.js";

export const prerender = false;

const createClientSchema = z.object({
	id: z
		.string()
		.min(1, "Client ID is required")
		.max(255, "Client ID must be at most 255 characters"),
	name: z.string().min(1, "Name is required").max(255, "Name must be at most 255 characters"),
	redirectUris: z
		.array(z.url("Each redirect URI must be a valid URL"))
		.min(1, "At least one redirect URI is required"),
	scopes: z.array(z.string()).optional(),
});

/**
 * List all registered OAuth clients.
 */
export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	if (!user || user.role < Role.ADMIN) {
		return apiError("FORBIDDEN", "Admin privileges required", 403);
	}

	const result = await handleOAuthClientList(emdash.db);
	return unwrapResult(result);
};

/**
 * Register a new OAuth client.
 */
export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	if (!user || user.role < Role.ADMIN) {
		return apiError("FORBIDDEN", "Admin privileges required", 403);
	}

	try {
		const body = await parseBody(request, createClientSchema);
		if (isParseError(body)) return body;

		const result = await handleOAuthClientCreate(emdash.db, body);
		return unwrapResult(result, 201);
	} catch (error) {
		return handleError(error, "Failed to create OAuth client", "CLIENT_CREATE_ERROR");
	}
};
