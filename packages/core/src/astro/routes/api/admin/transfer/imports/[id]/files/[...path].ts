/**
 * PUT /_emdash/api/admin/transfer/imports/:id/files/<package path>
 *
 * Upload one declared package file as the raw request body. `Content-Length`
 * is required and must equal the declared size; the body must hash to the
 * declared SHA-256. Re-sending an already verified file succeeds without
 * storing it again when its bytes match.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, requireDb, unwrapResult } from "#api/error.js";
import { handleImportFileUpload } from "#api/handlers/transfer.js";
import { requireScope } from "#auth/scopes.js";

import { TRANSFER_LIMITS } from "../../../../../../../../transfer/format/limits.js";

export const prerender = false;

const CONTENT_LENGTH_PATTERN = /^\d{1,16}$/;

export const PUT: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "transfer:import");
	if (denied) return denied;
	const scopeDenied = requireScope(locals, "transfer:analyze");
	if (scopeDenied) return scopeDenied;

	if (!emdash.storage) {
		return apiError("STORAGE_NOT_CONFIGURED", "No storage backend is configured", 503);
	}

	const header = request.headers.get("Content-Length");
	if (header === null) {
		return apiError("LENGTH_REQUIRED", "Content-Length is required", 411);
	}
	if (!CONTENT_LENGTH_PATTERN.test(header)) {
		return apiError("VALIDATION_ERROR", "Invalid Content-Length", 400);
	}

	return unwrapResult(
		await handleImportFileUpload(emdash.db, emdash.storage, {
			operationId: params.id ?? "",
			path: params.path ?? "",
			contentLength: Number(header),
			body: request.body,
			maxBlobBytes: emdash.config.maxUploadSize ?? TRANSFER_LIMITS.defaultMaxBlobBytes,
		}),
	);
};
