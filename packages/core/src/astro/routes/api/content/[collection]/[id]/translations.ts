/**
 * Content translations endpoint
 *
 * GET /_emdash/api/content/{collection}/{id}/translations
 *
 * Returns all locale variants linked to the same translation group.
 */

import { hasPermission } from "@emdash-cms/auth";
import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";

export const prerender = false;

function isPublished(t: unknown): boolean {
	return (
		typeof t === "object" &&
		t !== null &&
		"status" in t &&
		(t as Record<string, unknown>).status === "published"
	);
}

function isEntry(t: unknown, idOrSlug: string): boolean {
	return (
		typeof t === "object" &&
		t !== null &&
		(("id" in t && t.id === idOrSlug) || ("slug" in t && t.slug === idOrSlug))
	);
}

export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	if (!emdash?.handleContentTranslations) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	const denied = requirePerm(user, "content:read");
	if (denied) return denied;
	const collection = params.collection!;
	const id = params.id!;

	const result = await emdash.handleContentTranslations(collection, id);

	// Filter out non-published translations for users without read_drafts so a
	// subscriber can't enumerate locales that aren't yet live. The requested
	// entry is one of the translations; if it isn't published, return 404 so
	// its id or slug can't be probed either.
	if (result.success && !hasPermission(user, "content:read_drafts")) {
		const data =
			result.data && typeof result.data === "object"
				? // eslint-disable-next-line typescript/no-unsafe-type-assertion -- handler returns unknown data; narrowed by typeof check
					(result.data as Record<string, unknown>)
				: undefined;
		const translations = Array.isArray(data?.translations) ? data.translations : [];
		const filtered = translations.filter(isPublished);
		if (!filtered.some((t) => isEntry(t, id))) {
			return apiError("NOT_FOUND", `Content item not found: ${id}`, 404);
		}
		return unwrapResult({
			success: true,
			data: { ...data, translations: filtered },
		});
	}

	return unwrapResult(result);
};
