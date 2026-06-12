/**
 * Byline field reorder.
 *
 * POST /_emdash/api/admin/byline-fields/reorder
 *
 * Body: `{ slugs: string[] }` — the exact set of currently registered
 * slugs in the desired order. The registry rejects any drift
 * (`REORDER_MISMATCH` → 400). Empty `[]` against an empty registered
 * set is a no-op by registry contract; the zod schema permits it.
 *
 * Thin wrapper around `handleBylineFieldReorder`.
 *
 * Phase 4 of Discussion #1174.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { requireDb, unwrapResult } from "#api/error.js";
import { handleBylineFieldReorder } from "#api/handlers/byline-fields.js";
import { isParseError, parseBody } from "#api/parse.js";
import { bylineFieldReorderBody } from "#api/schemas.js";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;
	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const body = await parseBody(request, bylineFieldReorderBody);
	if (isParseError(body)) return body;

	const result = await handleBylineFieldReorder(emdash.db, body.slugs);
	return unwrapResult(result);
};
