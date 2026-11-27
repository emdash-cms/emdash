/**
 * Entry edit lock
 *
 * GET    /_emdash/api/content/{collection}/{id}/lock - Read the current holder
 * POST   /_emdash/api/content/{collection}/{id}/lock - Take or refresh the lock, or, while a
 *        co-editing room is open, delete every lock on the entry
 * DELETE /_emdash/api/content/{collection}/{id}/lock - Release the caller's lock
 */

import type { APIRoute } from "astro";

import { requireAnyPerm, requireEntryEditPerm } from "#api/authorize.js";
import { apiError, mapErrorStatus, unwrapResult } from "#api/error.js";
import {
	handleEntryLockAcquire,
	handleEntryLockRead,
	handleEntryLockRelease,
} from "#api/handlers/entry-lock.js";
import { isParseError, parseOptionalBody } from "#api/parse.js";
import { entryLockAcquireBody } from "#api/schemas.js";
import type { EmDashHandlers } from "#types";

export const prerender = false;

interface ResolvedEntry {
	emdash: EmDashHandlers;
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
	if (!emdash?.handleContentGetForWrite) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const roleDenied = requireAnyPerm(user, ["content:edit_own", "content:edit_own_drafts"]);
	if (roleDenied) return roleDenied;

	const existing = await emdash.handleContentGetForWrite(collection, id, locale);
	if (!existing.success) {
		return apiError(
			existing.error?.code ?? "UNKNOWN_ERROR",
			existing.error?.message ?? "Unknown error",
			mapErrorStatus(existing.error?.code),
		);
	}

	const existingItem = existing.data.item;
	const authorId = existingItem.authorId ?? "";
	const denied = requireEntryEditPerm(user, { authorId, status: existingItem.status });
	if (denied) return denied;

	return {
		emdash,
		resolvedId: existingItem.id,
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
		await handleEntryLockRead(
			resolved.emdash.db,
			collection,
			resolved.resolvedId,
			resolved.userId,
			{
				rooms: resolved.emdash.rooms,
			},
		),
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
			resolved.emdash.db,
			collection,
			resolved.resolvedId,
			resolved.userId,
			{ takeover: body?.takeover, token: body?.token, rooms: resolved.emdash.rooms },
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
			resolved.emdash.db,
			collection,
			resolved.resolvedId,
			resolved.userId,
			{ token: url.searchParams.get("token") ?? undefined },
		),
	);
};
