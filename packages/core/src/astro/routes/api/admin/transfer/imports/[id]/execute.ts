/**
 * POST /_emdash/api/admin/transfer/imports/:id/execute
 *
 * Starts a planned import. Body: `{ packageDigest, planDigest }`. Both
 * digests must match the reviewed package and plan. Then call `advance`
 * until the import ends.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, requireDb, unwrapResult } from "#api/error.js";
import { handleImportExecute } from "#api/handlers/transfer.js";
import { isParseError, parseBody } from "#api/parse.js";
import { transferImportExecuteBody } from "#api/schemas/transfer.js";
import { requireScope } from "#auth/scopes.js";

import { toSha256Digest } from "../../../../../../../transfer/format/digest.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	if (!user) return apiError("UNAUTHORIZED", "Authentication required", 401);
	const denied = requirePerm(user, "transfer:import");
	if (denied) return denied;
	const scopeDenied = requireScope(locals, "transfer:execute");
	if (scopeDenied) return scopeDenied;

	if (!emdash.storage) {
		return apiError("STORAGE_NOT_CONFIGURED", "No storage backend is configured", 503);
	}

	const body = await parseBody(request, transferImportExecuteBody);
	if (isParseError(body)) return body;

	return unwrapResult(
		await handleImportExecute(emdash.db, emdash.storage, {
			operationId: params.id ?? "",
			userId: user.id,
			packageDigest: toSha256Digest(body.packageDigest.slice("sha256:".length)),
			planDigest: toSha256Digest(body.planDigest.slice("sha256:".length)),
		}),
	);
};
