/**
 * Sections list and create endpoints
 *
 * GET  /_emdash/api/sections - List all sections (with filters)
 * POST /_emdash/api/sections - Create section
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleSectionCreate, handleSectionList } from "#api/handlers/sections.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { createSectionBody, sectionsListQuery } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;
	const db = emdash!.db;

	const denied = requirePerm(user, "sections:read");
	if (denied) return denied;

	try {
		const query = parseQuery(url, sectionsListQuery);
		if (isParseError(query)) return query;

		const result = await handleSectionList(db, query);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to fetch sections", "SECTION_LIST_ERROR");
	}
};

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;
	const db = emdash!.db;

	const denied = requirePerm(user, "sections:manage");
	if (denied) return denied;

	try {
		const body = await parseBody(request, createSectionBody);
		if (isParseError(body)) return body;

		const result = await handleSectionCreate(db, body);
		return unwrapResult(result, 201);
	} catch (error) {
		return handleError(error, "Failed to create section", "SECTION_CREATE_ERROR");
	}
};
