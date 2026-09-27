/**
 * Site exports
 *
 * GET  /_emdash/api/admin/transfer/exports — list exports, newest first.
 * POST /_emdash/api/admin/transfer/exports — start an export. Body:
 *      `{ comments?: boolean }`. An optional `Idempotency-Key` header makes
 *      retries return the same operation.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, requireDb, unwrapResult } from "#api/error.js";
import { handleExportCreate, handleExportList } from "#api/handlers/transfer.js";
import { isParseError, parseOptionalBody, parseQuery } from "#api/parse.js";
import { transferExportCreateBody, transferPaginationQuery } from "#api/schemas/transfer.js";
import { requireScope } from "#auth/scopes.js";

export const prerender = false;

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

export const GET: APIRoute = async ({ url, locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "transfer:export");
	if (denied) return denied;
	const scopeDenied = requireScope(locals, "transfer:export");
	if (scopeDenied) return scopeDenied;

	const query = parseQuery(url, transferPaginationQuery);
	if (isParseError(query)) return query;

	return unwrapResult(await handleExportList(emdash.db, query));
};

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	if (!user) return apiError("UNAUTHORIZED", "Authentication required", 401);
	const denied = requirePerm(user, "transfer:export");
	if (denied) return denied;
	const scopeDenied = requireScope(locals, "transfer:export");
	if (scopeDenied) return scopeDenied;

	const idempotencyKey = request.headers.get("Idempotency-Key") ?? undefined;
	if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
		return apiError("VALIDATION_ERROR", "Invalid Idempotency-Key header", 400);
	}

	const body = await parseOptionalBody(request, transferExportCreateBody, {});
	if (isParseError(body)) return body;

	const result = await handleExportCreate(emdash.db, {
		userId: user.id,
		options: body.comments === undefined ? {} : { comments: body.comments },
		idempotencyKey,
	});
	return unwrapResult(result, result.success && result.data.created ? 201 : 200);
};
