/**
 * GET /_emdash/api/admin/transfer/imports/:id/missing
 *
 * Declared package files not uploaded yet, in path order, paginated. Upload
 * every listed file, then list again: uploading an index chunk declares the
 * files it lists.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { requireDb, unwrapResult } from "#api/error.js";
import { handleImportMissing } from "#api/handlers/transfer.js";
import { isParseError, parseQuery } from "#api/parse.js";
import { transferPaginationQuery } from "#api/schemas/transfer.js";
import { requireScope } from "#auth/scopes.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, url, locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "transfer:import");
	if (denied) return denied;
	const scopeDenied = requireScope(locals, "transfer:analyze");
	if (scopeDenied) return scopeDenied;

	const query = parseQuery(url, transferPaginationQuery);
	if (isParseError(query)) return query;

	return unwrapResult(await handleImportMissing(emdash.db, params.id ?? "", query));
};
