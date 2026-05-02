/**
 * Publish content - promotes draft to live
 *
 * POST /_emdash/api/content/{collection}/{id}/publish
 *
 * Optional JSON body: { publishedAt?: string }
 *   publishedAt — ISO 8601 datetime to backdate the publish (e.g. when
 *   migrating content). Writing publishedAt requires content:publish_any.
 *   Without it, the existing published_at is preserved on re-publish and
 *   falls back to the current time on first publish.
 */

import { hasPermission } from "@emdash-cms/auth";
import type { APIRoute } from "astro";

import { requireOwnerPerm } from "#api/authorize.js";
import { apiError, mapErrorStatus, unwrapResult } from "#api/error.js";
import { isParseError, parseOptionalBody } from "#api/parse.js";
import { contentPublishBody } from "#api/schemas.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals, cache }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;
	const id = params.id!;

	if (!emdash?.handleContentPublish || !emdash?.handleContentGet) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	// Body is optional — empty body means use the legacy behavior (preserve
	// or default published_at). Pass `publishedAt` to backdate.
	const body = await parseOptionalBody(request, contentPublishBody, {});
	if (isParseError(body)) return body;

	// Fetch item to check ownership
	const existing = await emdash.handleContentGet(collection, id);
	if (!existing.success) {
		return apiError(
			existing.error?.code ?? "UNKNOWN_ERROR",
			existing.error?.message ?? "Unknown error",
			mapErrorStatus(existing.error?.code),
		);
	}

	const existingData =
		existing.data && typeof existing.data === "object"
			? // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- handler returns unknown data; narrowed by typeof check above
				(existing.data as Record<string, unknown>)
			: undefined;
	const existingItem =
		existingData?.item && typeof existingData.item === "object"
			? // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- narrowed by typeof check above
				(existingData.item as Record<string, unknown>)
			: existingData;
	const authorId = typeof existingItem?.authorId === "string" ? existingItem.authorId : "";
	const denied = requireOwnerPerm(user, authorId, "content:publish_own", "content:publish_any");
	if (denied) return denied;

	// Schema narrows `publishedAt` to `string | undefined`; null is rejected
	// at the schema layer (publish has no semantic meaning for "clear").
	const publishedAt = body?.publishedAt;

	// Backdating overwrites historical record — gate behind publish_any
	// regardless of ownership.
	if (publishedAt !== undefined && !hasPermission(user, "content:publish_any")) {
		return apiError(
			"FORBIDDEN",
			"Setting publishedAt requires content:publish_any permission",
			403,
		);
	}

	const resolvedId = typeof existingItem?.id === "string" ? existingItem.id : id;

	const result = await emdash.handleContentPublish(collection, resolvedId, {
		publishedAt,
	});

	if (!result.success) return unwrapResult(result);

	if (cache.enabled) await cache.invalidate({ tags: [collection, resolvedId] });

	return unwrapResult(result);
};
