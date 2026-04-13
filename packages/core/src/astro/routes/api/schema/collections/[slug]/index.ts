/**
 * Schema collection CRUD endpoints
 *
 * GET    /_emdash/api/schema/collections/{slug} - Get collection
 * PUT    /_emdash/api/schema/collections/{slug} - Update collection
 * DELETE /_emdash/api/schema/collections/{slug} - Delete collection
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { requireDb, unwrapResult } from "#api/error.js";
import {
	handleSchemaCollectionGet,
	handleSchemaCollectionUpdate,
	handleSchemaCollectionDelete,
} from "#api/index.js";
import { parseBody, parseQuery, isParseError } from "#api/parse.js";
import { collectionGetQuery, updateCollectionBody } from "#api/schemas.js";
import type { UpdateCollectionInput } from "#schema/types.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, url, locals }) => {
	const { emdash, user } = locals;
	const slug = params.slug!;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:read");
	if (denied) return denied;

	const query = parseQuery(url, collectionGetQuery);
	if (isParseError(query)) return query;

	const result = await handleSchemaCollectionGet(emdash!.db, slug, {
		includeFields: query.includeFields ?? false,
	});
	return unwrapResult(result);
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const slug = params.slug!;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	const body = await parseBody(request, updateCollectionBody);
	if (isParseError(body)) return body;

	const result = await handleSchemaCollectionUpdate(
		emdash!.db,
		slug,
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- parseBody validates via Zod
		body as UpdateCollectionInput,
	);
	emdash!.invalidateManifest();
	return unwrapResult(result);
};

export const DELETE: APIRoute = async ({ params, url, locals }) => {
	const { emdash, user } = locals;
	const slug = params.slug!;
	const force = url.searchParams.get("force") === "true";

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	const result = await handleSchemaCollectionDelete(emdash!.db, slug, {
		force,
	});
	emdash!.invalidateManifest();
	return unwrapResult(result);
};
