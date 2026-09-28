/**
 * Entry edit lock
 *
 * GET    /_emdash/api/content/{collection}/{id}/lock - Read the current holder
 * POST   /_emdash/api/content/{collection}/{id}/lock - Take or refresh the lock
 * DELETE /_emdash/api/content/{collection}/{id}/lock - Release the caller's lock
 */

import type { APIRoute } from "astro";

import { requireOwnerPerm } from "#api/authorize.js";
import { apiError, mapErrorStatus, unwrapResult } from "#api/error.js";
import {
	handleEntryLockAcquire,
	handleEntryLockRead,
	handleEntryLockRelease,
} from "#api/handlers/entry-lock.js";
import { isParseError, parseOptionalBody } from "#api/parse.js";
import { entryLockAcquireBody } from "#api/schemas.js";

export const prerender = false;

interface ResolvedEntry {
	resolvedId: string;
	userId: string;
}

/**
 * Resolves the entry the way every other single-entry route does, and applies
 * the same edit permission, since holding a lock is the prelude to a write.
 */
async function resolveEntry(
	locals: App.Locals,
	collection: string,
	id: string,
	locale: string | undefined,
): Promise<ResolvedEntry | Response> {
	const { emdash, user } = locals;
	if (!emdash?.handleContentGet) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const existing = await emdash.handleContentGet(collection, id, locale);
	if (!existing.success) {
		return apiError(
			existing.error?.code ?? "UNKNOWN_ERROR",
			existing.error?.message ?? "Unknown error",
			mapErrorStatus(existing.error?.code),
		);
	}

	const existingData =
		existing.data && typeof existing.data === "object"
			? // eslint-disable-next-line typescript/no-unsafe-type-assertion -- handler returns unknown data; narrowed by typeof check above
				(existing.data as Record<string, unknown>)
			: undefined;
	const existingItem =
		existingData?.item && typeof existingData.item === "object"
			? // eslint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by typeof check above
				(existingData.item as Record<string, unknown>)
			: existingData;
	const authorId = typeof existingItem?.authorId === "string" ? existingItem.authorId : "";
	const denied = requireOwnerPerm(user, authorId, "content:edit_own", "content:edit_any");
	if (denied) return denied;

	return {
		resolvedId: typeof existingItem?.id === "string" ? existingItem.id : id,
		userId: user!.id,
	};
}

export const GET: APIRoute = async ({ params, locals, url }) => {
	const collection = params.collection!;
	const id = params.id!;
	const resolved = await resolveEntry(
		locals,
		collection,
		id,
		url.searchParams.get("locale") || undefined,
	);
	if (resolved instanceof Response) return resolved;

	return unwrapResult(
		await handleEntryLockRead(locals.emdash.db, collection, resolved.resolvedId, resolved.userId),
	);
};

export const POST: APIRoute = async ({ params, request, locals, url }) => {
	const collection = params.collection!;
	const id = params.id!;
	const body = await parseOptionalBody(request, entryLockAcquireBody, {});
	if (isParseError(body)) return body;

	const resolved = await resolveEntry(
		locals,
		collection,
		id,
		url.searchParams.get("locale") || undefined,
	);
	if (resolved instanceof Response) return resolved;

	return unwrapResult(
		await handleEntryLockAcquire(
			locals.emdash.db,
			collection,
			resolved.resolvedId,
			resolved.userId,
			{ takeover: body?.takeover, token: body?.token },
		),
	);
};

export const DELETE: APIRoute = async ({ params, locals, url }) => {
	const collection = params.collection!;
	const id = params.id!;
	const resolved = await resolveEntry(
		locals,
		collection,
		id,
		url.searchParams.get("locale") || undefined,
	);
	if (resolved instanceof Response) return resolved;

	return unwrapResult(
		await handleEntryLockRelease(
			locals.emdash.db,
			collection,
			resolved.resolvedId,
			resolved.userId,
			{ token: url.searchParams.get("token") ?? undefined },
		),
	);
};
