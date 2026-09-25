/**
 * Site imports
 *
 * GET  /_emdash/api/admin/transfer/imports — list imports, newest first.
 * POST /_emdash/api/admin/transfer/imports — create an import. The body is the
 *      package's `manifest.json` bytes, unchanged. An optional
 *      `Idempotency-Key` header makes retries return the same operation.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, requireDb, unwrapResult } from "#api/error.js";
import { handleImportCreate, handleImportList } from "#api/handlers/transfer.js";
import { isParseError, parseQuery } from "#api/parse.js";
import { transferPaginationQuery } from "#api/schemas/transfer.js";
import { requireAnyScope, requireScope } from "#auth/scopes.js";

import { isTransferError } from "../../../../../../transfer/errors.js";
import { TRANSFER_LIMITS } from "../../../../../../transfer/format/limits.js";
import { readStreamBytes } from "../../../../../../transfer/staging/stage.js";

export const prerender = false;

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

export const GET: APIRoute = async ({ url, locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "transfer:import");
	if (denied) return denied;
	const scopeDenied = requireAnyScope(locals, ["transfer:analyze", "transfer:execute"]);
	if (scopeDenied) return scopeDenied;

	const query = parseQuery(url, transferPaginationQuery);
	if (isParseError(query)) return query;

	return unwrapResult(await handleImportList(emdash.db, query));
};

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	if (!user) return apiError("UNAUTHORIZED", "Authentication required", 401);
	const denied = requirePerm(user, "transfer:import");
	if (denied) return denied;
	const scopeDenied = requireScope(locals, "transfer:analyze");
	if (scopeDenied) return scopeDenied;

	if (!emdash.storage) {
		return apiError("STORAGE_NOT_CONFIGURED", "No storage backend is configured", 503);
	}

	const idempotencyKey = request.headers.get("Idempotency-Key") ?? undefined;
	if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
		return apiError("VALIDATION_ERROR", "Invalid Idempotency-Key header", 400);
	}

	const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
	if (declaredLength > TRANSFER_LIMITS.manifestBytes) {
		return apiError("TRANSFER_LIMIT_EXCEEDED", "Manifest is too large", 413);
	}
	if (!request.body) {
		return apiError("TRANSFER_MANIFEST_INVALID", "Request body must be the package manifest", 422);
	}

	let manifest: Uint8Array;
	try {
		manifest = await readStreamBytes(request.body, TRANSFER_LIMITS.manifestBytes);
	} catch (error) {
		if (isTransferError(error)) return apiError(error.code, error.message, error.status);
		return apiError("TRANSFER_MANIFEST_INVALID", "Failed to read the manifest", 400);
	}

	const result = await handleImportCreate(emdash.db, emdash.storage, {
		userId: user.id,
		manifest,
		idempotencyKey,
	});
	return unwrapResult(result, result.success && result.data.created ? 201 : 200);
};
