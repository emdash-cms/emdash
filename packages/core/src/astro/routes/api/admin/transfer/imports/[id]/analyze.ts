/**
 * POST /_emdash/api/admin/transfer/imports/:id/analyze
 *
 * Runs one bounded analysis step. Call again after `nextRequestInMs` until it
 * is null; the response then carries the plan and its digest. `decisions`
 * (principal mappings, title and tagline choices) are applied once the
 * import is planned.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, requireDb, unwrapResult } from "#api/error.js";
import { handleImportAnalyze } from "#api/handlers/transfer.js";
import { isParseError, parseOptionalBody } from "#api/parse.js";
import { transferImportAnalyzeBody } from "#api/schemas/transfer.js";
import { requireScope } from "#auth/scopes.js";

import { getI18nConfig } from "../../../../../../../i18n/config.js";
import { analysisTargetContext } from "../../../../../../../transfer/analyze/target.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
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

	const body = await parseOptionalBody(request, transferImportAnalyzeBody, {});
	if (isParseError(body)) return body;

	return unwrapResult(
		await handleImportAnalyze(emdash.db, emdash.storage, {
			operationId: params.id ?? "",
			decisions: body.decisions,
			target: analysisTargetContext({
				i18n: getI18nConfig(),
				maxUploadSize: emdash.config.maxUploadSize,
			}),
		}),
	);
};
