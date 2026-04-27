/**
 * Schema field CRUD endpoints
 *
 * GET    /_emdash/api/schema/collections/{slug}/fields/{fieldSlug} - Get field
 * PUT    /_emdash/api/schema/collections/{slug}/fields/{fieldSlug} - Update field
 * DELETE /_emdash/api/schema/collections/{slug}/fields/{fieldSlug} - Delete field
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { requireDb, unwrapResult } from "#api/error.js";
import {
	handleSchemaFieldGet,
	handleSchemaFieldUpdate,
	handleSchemaFieldDelete,
} from "#api/index.js";
import { parseBody, isParseError } from "#api/parse.js";
import { updateFieldBody } from "#api/schemas.js";
import type { UpdateFieldInput } from "#schema/types.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const collectionSlug = params.slug!;
	const fieldSlug = params.fieldSlug!;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:read");
	if (denied) return denied;

	const result = await handleSchemaFieldGet(emdash!.db, collectionSlug, fieldSlug);
	return unwrapResult(result);
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const collectionSlug = params.slug!;
	const fieldSlug = params.fieldSlug!;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	const body = await parseBody(request, updateFieldBody);
	if (isParseError(body)) return body;

	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- body is Zod-validated via parseBody(request, updateFieldBody) above
	const result = await handleSchemaFieldUpdate(
		emdash!.db,
		collectionSlug,
		fieldSlug,
		body as UpdateFieldInput,
	);
	if (result.success) emdash!.invalidateManifest();
	return unwrapResult(result);
};

export const DELETE: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const collectionSlug = params.slug!;
	const fieldSlug = params.fieldSlug!;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	const result = await handleSchemaFieldDelete(emdash!.db, collectionSlug, fieldSlug);
	if (result.success) emdash!.invalidateManifest();
	return unwrapResult(result);
};
