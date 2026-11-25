/**
 * Schema fields list and create endpoints
 *
 * GET  /_emdash/api/schema/collections/{slug}/fields - List fields
 * POST /_emdash/api/schema/collections/{slug}/fields - Create field
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleSchemaFieldList, handleSchemaFieldCreate } from "#api/index.js";
import { parseBody, isParseError } from "#api/parse.js";
import { createFieldBody } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const collectionSlug = params.slug!;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "schema:read");
	if (denied) return denied;

	const result = await handleSchemaFieldList(emdash.db, collectionSlug);
	return unwrapResult(result);
};

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const collectionSlug = params.slug!;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	const body = await parseBody(request, createFieldBody);
	if (isParseError(body)) return body;

	const result = await handleSchemaFieldCreate(emdash.db, collectionSlug, body);
	return unwrapResult(result, 201);
};
