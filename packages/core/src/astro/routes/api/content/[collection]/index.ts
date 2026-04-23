/**
 * Content list and create endpoints - injected by EmDash integration
 *
 * GET  /_emdash/api/content/{collection} - List content
 * POST /_emdash/api/content/{collection} - Create content
 */

import { hasPermission } from "@emdash-cms/auth";
import type { APIRoute } from "astro";

import { requirePerm, requireOwnerPerm } from "#api/authorize.js";
import { apiError, mapErrorStatus, unwrapResult } from "#api/error.js";
import { parseBody, parseQuery, isParseError } from "#api/parse.js";
import { contentListQuery, contentCreateBody } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, url, locals }) => {
	const { emdash, user } = locals;
	const denied = requirePerm(user, "content:read");
	if (denied) return denied;
	const collection = params.collection!;
	const query = parseQuery(url, contentListQuery);
	if (isParseError(query)) return query;

	if (!emdash?.handleContentList) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	// Subscribers must only see published content; force the status filter
	// regardless of caller-supplied value. Any user with content:read_drafts
	// (CONTRIBUTOR+) keeps the requested filter.
	const params_ = hasPermission(user, "content:read_drafts")
		? query
		: { ...query, status: "published" };

	const result = await emdash.handleContentList(collection, params_);

	return unwrapResult(result);
};

export const POST: APIRoute = async ({ params, request, locals, cache }) => {
	const { emdash, user } = locals;
	const denied = requirePerm(user, "content:create");
	if (denied) return denied;
	const collection = params.collection!;
	const body = await parseBody(request, contentCreateBody);
	if (isParseError(body)) return body;

	if (!emdash?.handleContentCreate || !emdash?.handleContentGet) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	// Creating a translation requires edit permission on the source item
	if (body.translationOf) {
		const source = await emdash.handleContentGet(collection, body.translationOf);
		if (!source.success) {
			return apiError(
				source.error?.code ?? "NOT_FOUND",
				source.error?.message ?? "Translation source not found",
				mapErrorStatus(source.error?.code),
			);
		}
		const sourceData =
			source.data && typeof source.data === "object"
				? (source.data as Record<string, unknown>)
				: undefined;
		const sourceItem =
			sourceData?.item && typeof sourceData.item === "object"
				? (sourceData.item as Record<string, unknown>)
				: sourceData;
		const sourceAuthor = typeof sourceItem?.authorId === "string" ? sourceItem.authorId : "";
		const translationDenied = requireOwnerPerm(
			user,
			sourceAuthor,
			"content:edit_own",
			"content:edit_any",
		);
		if (translationDenied) return translationDenied;
	}

	// Auto-set authorId to current user when creating content
	const result = await emdash.handleContentCreate(collection, {
		...body,
		authorId: user?.id,
		locale: body.locale,
		translationOf: body.translationOf,
	});

	if (!result.success) return unwrapResult(result);

	if (cache.enabled) await cache.invalidate({ tags: [collection] });

	return unwrapResult(result, 201);
};
