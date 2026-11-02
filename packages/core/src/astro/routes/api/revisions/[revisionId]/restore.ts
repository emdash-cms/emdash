/**
 * Restore revision endpoint - injected by EmDash integration
 *
 * POST /_emdash/api/revisions/{revisionId}/restore - Restore revision
 *
 * Optional JSON body: { overrideLock?: boolean }
 */

import type { APIRoute } from "astro";

import { requireOwnerPerm } from "#api/authorize.js";
import { apiError, mapErrorStatus, unwrapResult } from "#api/error.js";
import { claimEntryLockForWrite } from "#api/handlers/entry-lock.js";
import { isParseError, parseOptionalBody } from "#api/parse.js";
import { revisionRestoreBody } from "#api/schemas.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const revisionId = params.revisionId!;
	const body = await parseOptionalBody(request, revisionRestoreBody, {});
	if (isParseError(body)) return body;

	if (!emdash?.handleRevisionRestore || !emdash?.handleRevisionGet || !emdash?.handleContentGet) {
		return apiError("NOT_CONFIGURED", "EmDash not configured", 500);
	}

	// Fetch the revision to discover which content entry it belongs to
	const revision = await emdash.handleRevisionGet(revisionId);
	if (!revision.success) {
		return apiError(
			revision.error?.code ?? "UNKNOWN_ERROR",
			revision.error?.message ?? "Revision not found",
			mapErrorStatus(revision.error?.code),
		);
	}

	const collection = revision.data?.item?.collection;
	const entryId = revision.data?.item?.entryId;

	if (!collection || !entryId) {
		return apiError("INVALID_REVISION", "Revision is missing collection or entry reference", 400);
	}

	// Fetch the content entry to check ownership
	const existing = await emdash.handleContentGet(collection, entryId);
	if (!existing.success) {
		return apiError(
			existing.error?.code ?? "UNKNOWN_ERROR",
			existing.error?.message ?? "Content not found",
			mapErrorStatus(existing.error?.code),
		);
	}

	const authorId = existing.data?.item?.authorId ?? "";

	// Check ownership: authors can only restore their own content, editors+ can restore any
	const denied = requireOwnerPerm(user, authorId, "content:edit_own", "content:edit_any");
	if (denied) return denied;

	const refusal = await claimEntryLockForWrite(emdash.db, collection, entryId, user!.id, {
		override: body.overrideLock,
	});
	if (refusal) {
		return apiError(refusal.code, refusal.message, mapErrorStatus(refusal.code), {
			...refusal.details,
		});
	}

	const result = await emdash.handleRevisionRestore(revisionId, user!.id);

	return unwrapResult(result);
};
