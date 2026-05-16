/**
 * Schedule content for future publishing - injected by EmDash integration
 *
 * POST /_emdash/api/content/{collection}/{id}/schedule - Schedule for publishing
 * DELETE /_emdash/api/content/{collection}/{id}/schedule - Unschedule (clear scheduled time)
 */

import type { APIRoute } from "astro";

import { requireOwnerPerm } from "#api/authorize.js";
import { apiError, mapErrorStatus, unwrapResult } from "#api/error.js";
import { parseBody, isParseError } from "#api/parse.js";
import { contentScheduleBody } from "#api/schemas.js";

export const prerender = false;

/**
 * Extract author ID from a content item response (shared by POST and DELETE).
 */
function extractOwnership(data: unknown): { authorId: string; resolvedId: string | undefined } {
	const obj =
		data && typeof data === "object"
			? // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- handler returns unknown; narrowed by typeof
				(data as Record<string, unknown>)
			: undefined;
	const item =
		obj?.item && typeof obj.item === "object"
			? // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- narrowed by typeof
				(obj.item as Record<string, unknown>)
			: obj;
	return {
		authorId: typeof item?.authorId === "string" ? item.authorId : "",
		resolvedId: typeof item?.id === "string" ? item.id : undefined,
	};
}

export const POST: APIRoute = async ({ params, request, locals, cache }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;
	const id = params.id!;
	const body = await parseBody(request, contentScheduleBody);
	if (isParseError(body)) return body;

	if (!emdash?.handleContentSchedule || !emdash?.handleContentGet) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	// Fetch item to check ownership
	const existing = await emdash.handleContentGet(collection, id);
	if (!existing.success) {
		return apiError(
			existing.error?.code ?? "UNKNOWN_ERROR",
			existing.error?.message ?? "Unknown error",
			mapErrorStatus(existing.error?.code),
		);
	}

	const { authorId, resolvedId } = extractOwnership(existing.data);
	const denied = requireOwnerPerm(user, authorId, "content:publish_own", "content:publish_any");
	if (denied) return denied;

	const result = await emdash.handleContentSchedule(collection, resolvedId ?? id, body.scheduledAt);

	if (!result.success) return unwrapResult(result);

	if (cache?.enabled) await cache.invalidate({ tags: [collection, resolvedId ?? id] });

	return unwrapResult(result);
};

export const DELETE: APIRoute = async ({ params, locals, cache }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;
	const id = params.id!;

	if (!emdash?.handleContentUnschedule || !emdash?.handleContentGet) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	// Fetch item to check ownership
	const existing = await emdash.handleContentGet(collection, id);
	if (!existing.success) {
		return apiError(
			existing.error?.code ?? "UNKNOWN_ERROR",
			existing.error?.message ?? "Unknown error",
			mapErrorStatus(existing.error?.code),
		);
	}

	const { authorId, resolvedId } = extractOwnership(existing.data);
	const denied = requireOwnerPerm(user, authorId, "content:publish_own", "content:publish_any");
	if (denied) return denied;

	const result = await emdash.handleContentUnschedule(collection, resolvedId ?? id);

	if (!result.success) return unwrapResult(result);

	if (cache?.enabled) await cache.invalidate({ tags: [collection, resolvedId ?? id] });

	return unwrapResult(result);
};
