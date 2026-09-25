/**
 * GET /_emdash/api/admin/transfer/capabilities
 *
 * Supported package formats, features, and limits, and whether this site can
 * receive an import (with the reasons it cannot).
 */

import type { APIRoute } from "astro";

import { requireAnyPerm } from "#api/authorize.js";
import { requireDb, unwrapResult } from "#api/error.js";
import { handleTransferCapabilities } from "#api/handlers/transfer.js";
import { requireAnyScope } from "#auth/scopes.js";

import { getI18nConfig } from "../../../../../i18n/config.js";
import { analysisTargetContext } from "../../../../../transfer/analyze/target.js";
import { TRANSFER_SCOPES } from "../../../../../transfer/auth.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requireAnyPerm(user, ["transfer:export", "transfer:import"]);
	if (denied) return denied;
	const scopeDenied = requireAnyScope(locals, TRANSFER_SCOPES);
	if (scopeDenied) return scopeDenied;

	const target = analysisTargetContext({
		i18n: getI18nConfig(),
		maxUploadSize: emdash.config.maxUploadSize,
	});
	return unwrapResult(await handleTransferCapabilities(emdash.db, target));
};
