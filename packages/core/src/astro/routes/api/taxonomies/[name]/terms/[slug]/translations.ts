/**
 * Term translation endpoints
 *
 * GET  /_emdash/api/taxonomies/:name/terms/:slug/translations[?locale=xx]
 * POST /_emdash/api/taxonomies/:name/terms/:slug/translations
 *    body: { locale, label?, slug? }
 */

import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, requireDb, unwrapResult } from "#api/error.js";
import {
	handleTermCreate,
	handleTermGet,
	handleTermTranslations,
} from "#api/handlers/taxonomies.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { localeFilterQuery } from "#api/schemas.js";

export const prerender = false;

const createTermTranslationBody = z
	.object({
		locale: z.string().min(1),
		label: z.string().min(1).optional(),
		slug: z.string().min(1).optional(),
	})
	.meta({ id: "CreateTermTranslationBody" });

export const GET: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { name, slug } = params;
	if (!name || !slug) return apiError("VALIDATION_ERROR", "Taxonomy name and slug required", 400);

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "taxonomies:read");
	if (denied) return denied;

	const query = parseQuery(new URL(request.url), localeFilterQuery);
	if (isParseError(query)) return query;

	try {
		const anchor = await handleTermGet(emdash.db, name, slug, { locale: query.locale });
		if (!anchor.success) return unwrapResult(anchor);
		const result = await handleTermTranslations(emdash.db, anchor.data.term.id);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to list term translations", "TERM_TRANSLATIONS_ERROR");
	}
};

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { name, slug } = params;
	if (!name || !slug) return apiError("VALIDATION_ERROR", "Taxonomy name and slug required", 400);

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "taxonomies:manage");
	if (denied) return denied;

	const query = parseQuery(new URL(request.url), localeFilterQuery);
	if (isParseError(query)) return query;

	try {
		const body = await parseBody(request, createTermTranslationBody);
		if (isParseError(body)) return body;

		const source = await handleTermGet(emdash.db, name, slug, { locale: query.locale });
		if (!source.success) return unwrapResult(source);

		const result = await handleTermCreate(emdash.db, name, {
			slug: body.slug ?? source.data.term.slug,
			label: body.label ?? source.data.term.label,
			parentId: source.data.term.parentId,
			description: source.data.term.description,
			locale: body.locale,
			translationOf: source.data.term.id,
		});
		return unwrapResult(result, 201);
	} catch (error) {
		return handleError(error, "Failed to create term translation", "TERM_TRANSLATION_CREATE_ERROR");
	}
};
