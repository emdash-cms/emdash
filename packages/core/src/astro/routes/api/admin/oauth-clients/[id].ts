/**
 * Single OAuth client endpoints
 *
 * GET    /_emdash/api/admin/oauth-clients/:id — Get a client
 * PUT    /_emdash/api/admin/oauth-clients/:id — Update a client
 * DELETE /_emdash/api/admin/oauth-clients/:id — Delete a client
 */

import { Role } from "@emdash-cms/auth";
import type { APIRoute } from "astro";
import { z } from "zod";

import { apiError, handleError, unwrapResult } from "#api/error.js";
import {
	handleOAuthClientDelete,
	handleOAuthClientGet,
	handleOAuthClientUpdate,
} from "#api/handlers/oauth-clients.js";
import { isParseError, parseBody } from "#api/parse.js";

export const prerender = false;

const updateClientSchema = z.object({
	name: z.string().min(1).max(255).optional(),
	redirectUris: z
		.array(z.url("Each redirect URI must be a valid URL"))
		.min(1, "At least one redirect URI is required")
		.optional(),
	scopes: z.array(z.string()).nullable().optional(),
});

/**
 * Get a single OAuth client.
 */
export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	if (!user || user.role < Role.ADMIN) {
		return apiError("FORBIDDEN", "Admin privileges required", 403);
	}

	const clientId = params.id;
	if (!clientId) {
		return apiError("VALIDATION_ERROR", "Client ID is required", 400);
	}

	const result = await handleOAuthClientGet(emdash.db, clientId);
	return unwrapResult(result);
};

/**
 * Update an OAuth client.
 */
export const PUT: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	if (!user || user.role < Role.ADMIN) {
		return apiError("FORBIDDEN", "Admin privileges required", 403);
	}

	const clientId = params.id;
	if (!clientId) {
		return apiError("VALIDATION_ERROR", "Client ID is required", 400);
	}

	try {
		const body = await parseBody(request, updateClientSchema);
		if (isParseError(body)) return body;

		const result = await handleOAuthClientUpdate(emdash.db, clientId, body);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to update OAuth client", "CLIENT_UPDATE_ERROR");
	}
};

/**
 * Delete an OAuth client.
 */
export const DELETE: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	if (!user || user.role < Role.ADMIN) {
		return apiError("FORBIDDEN", "Admin privileges required", 403);
	}

	const clientId = params.id;
	if (!clientId) {
		return apiError("VALIDATION_ERROR", "Client ID is required", 400);
	}

	try {
		const result = await handleOAuthClientDelete(emdash.db, clientId);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to delete OAuth client", "CLIENT_DELETE_ERROR");
	}
};
