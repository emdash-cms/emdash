/**
 * GET  /_emdash/api/oauth/device/authorize?user_code=XXXX-XXXX
 * POST /_emdash/api/oauth/device/authorize
 *
 * GET returns the scopes a pending user code requested, for display before
 * approval. POST approves or denies the code after the user logs in via the
 * browser. Both require authentication (the user must be logged in).
 */

/// <reference types="emdash/locals" />

import type { APIRoute } from "astro";
import { z } from "zod";

import { apiError, handleError, unwrapResult } from "#api/error.js";
import { handleDeviceAuthorize, handleDeviceCodeLookup } from "#api/handlers/device-flow.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";

export const prerender = false;

const lookupSchema = z.object({
	user_code: z.string().min(1),
});

const authorizeSchema = z.object({
	user_code: z.string().min(1),
	action: z.enum(["approve", "deny"]).optional(),
});

export const GET: APIRoute = async ({ url, locals }) => {
	const { emdash } = locals;
	const { user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	if (!user) {
		return apiError("NOT_AUTHENTICATED", "Authentication required", 401);
	}

	try {
		const query = parseQuery(url, lookupSchema);
		if (isParseError(query)) return query;

		const result = await handleDeviceCodeLookup(emdash.db, user.role, query);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to look up device code", "DEVICE_CODE_LOOKUP_ERROR");
	}
};

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash } = locals;
	const { user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	if (!user) {
		return apiError("NOT_AUTHENTICATED", "Authentication required", 401);
	}

	try {
		const body = await parseBody(request, authorizeSchema);
		if (isParseError(body)) return body;

		const result = await handleDeviceAuthorize(emdash.db, user.id, user.role, body);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to authorize device", "AUTHORIZE_ERROR");
	}
};
