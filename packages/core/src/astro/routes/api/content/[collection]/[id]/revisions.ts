/**
 * Revisions API endpoint - injected by EmDash integration
 *
 * GET  /_emdash/api/content/{collection}/{id}/revisions - List revisions
 * POST /_emdash/api/content/{collection}/{id}/revisions - Save a recovery revision
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleRecoveryRevisionCreate } from "#api/handlers/rooms.js";
import { isParseError, parseBody } from "#api/parse.js";
import { recoveryRevisionBody } from "#api/schemas.js";

import { MAX_RECOVERY_BYTES } from "../../../../../../rooms/limits.js";

export const prerender = false;

const encoder = new TextEncoder();

export const GET: APIRoute = async ({ params, url, locals }) => {
	const { emdash, user } = locals;
	if (!emdash?.handleRevisionList) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	const denied = requirePerm(user, "content:read_drafts");
	if (denied) return denied;
	const collection = params.collection!;
	const id = params.id!;

	const limitParam = url.searchParams.get("limit");
	const parsedLimit = limitParam ? parseInt(limitParam, 10) : undefined;
	const result = await emdash.handleRevisionList(collection, id, {
		limit: parsedLimit ? Math.max(1, Math.min(parsedLimit, 100)) : undefined,
	});

	return unwrapResult(result);
};

export const POST: APIRoute = async ({ params, request, url, locals }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	if (locals.tokenScopes !== undefined) {
		return apiError("FORBIDDEN", "Saving a recovery revision requires a signed-in session", 403);
	}
	const body = await parseBody(request, recoveryRevisionBody);
	if (isParseError(body)) return body;
	const data = { ...body.data, _slug: body.slug };
	if (encoder.encode(JSON.stringify(data)).byteLength > MAX_RECOVERY_BYTES) {
		return apiError("PAYLOAD_TOO_LARGE", "The recovery revision is too large", 413);
	}

	return unwrapResult(
		await handleRecoveryRevisionCreate(emdash.db, {
			collection: params.collection!,
			id: params.id!,
			locale: url.searchParams.get("locale") || undefined,
			user,
			data: body.data,
			slug: body.slug,
		}),
		201,
	);
};
