/**
 * The content save steps: the edit check, an optional lock check, an optional
 * site-write fence, and the runtime update. The content `PUT` route saves
 * through them, and so does any other caller that saves as a user.
 */

import { hasPermission, type RoleLevel } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import type { z } from "zod";

import type { EmDashHandlers, HandlerResponse } from "../astro/types.js";
import { ContentRepository } from "../database/repositories/content.js";
import { RevisionRepository } from "../database/repositories/revision.js";
import type { ContentItem } from "../database/repositories/types.js";
import type { Database } from "../database/types.js";
import {
	assertSiteWriteAllowed,
	SiteWriteBlockedError,
	type RecordSiteWrite,
} from "../transfer/fence.js";
import { entryEditAccess } from "./authorize.js";
import { validateRev } from "./rev.js";
import type { contentUpdateBody } from "./schemas/index.js";

/** The handlers a save needs: the runtime, or the `emdash` handlers in Astro locals. */
export interface ContentSaveSite {
	db: Kysely<Database>;
	handleContentGet: (collection: string, id: string, locale?: string) => Promise<HandlerResponse>;
	handleContentUpdate: EmDashHandlers["handleContentUpdate"];
}

export interface ContentSaveError {
	code: string;
	message: string;
	details?: Record<string, unknown>;
}

/** The content `PUT` body without `overrideLock`. */
export type ContentSaveBody = Omit<z.infer<typeof contentUpdateBody>, "overrideLock">;

export interface ContentSaveInput {
	collection: string;
	/** Entry ID or slug. */
	id: string;
	/** The locale a slug resolves in. */
	locale?: string;
	/** The actor. Their current role decides access. */
	user: { id: string; role: RoleLevel } | null | undefined;
	body: ContentSaveBody;
	/** Users whose edits this save holds, latest first. Defaults to the actor alone. */
	editedBy?: readonly string[];
	/**
	 * Apply the site-write fence, as plugin writes do. A refusal fails the save.
	 * Leave it off where request middleware already applies the fence.
	 */
	fence?: boolean;
	/**
	 * Runs with the resolved entry ID after the access checks and before
	 * anything is written. A returned error refuses the save.
	 */
	beforeWrite?: (entryId: string) => Promise<ContentSaveError | null>;
}

/** The `_rev` and stored values of a save's own write. */
export interface ContentWrite {
	rev: string;
	/** Stored field values, after hooks and normalization. */
	data: Record<string, unknown>;
	/** The staged slug, or else the live slug. */
	slug: string | null;
}

/** The runtime update's result. `saved` sits beside `data`, never in it. */
export type ContentSaveResult = Awaited<ReturnType<EmDashHandlers["handleContentUpdate"]>>;

function failure(code: string, message: string): ContentSaveResult {
	return { success: false, error: { code, message } };
}

/**
 * Save an entry as `input.user`, with the checks the content `PUT` makes.
 *
 * - `user` must be the actor's current, enabled account. A caller whose actor
 *   was deleted or disabled treats the save as `FORBIDDEN` instead of calling
 *   this.
 * - Send `data` with every save, `{}` when only the slug changes. A body
 *   without `data` or `references` skips draft staging and writes the live
 *   slug.
 * - `saved` is present only when the save staged a draft revision and wrote no
 *   live metadata. Take the write's `_rev` and stored values from it: reading
 *   the entry again can pick up another write.
 * - Nothing here purges route caches. `liveContentChanged: false` means the
 *   save changed no live content.
 */
export async function saveContent(
	site: ContentSaveSite,
	input: ContentSaveInput,
): Promise<ContentSaveResult> {
	const { collection, locale, body } = input;

	const grant = await checkEditAccess(site, input);
	if ("code" in grant) return failure(grant.code, grant.message);
	const { user, access, checkedRev } = grant;
	// A draft-only grant covers the entry only while it is a draft. Conditioning
	// the save on the checked revision makes it fail if the entry is published
	// between this check and the write.
	const rev = access === "draft" ? (body._rev ?? checkedRev) : body._rev;

	// Only EDITOR+ can write publishedAt directly — incl. clearing to null.
	if (body.publishedAt !== undefined && !hasPermission(user, "content:publish_any")) {
		return failure("FORBIDDEN", "Writing publishedAt requires content:publish_any permission");
	}

	const resolvedId = grant.entryId;

	const refusal = await input.beforeWrite?.(resolvedId);
	if (refusal) return { success: false, error: refusal };

	let recordWrite: RecordSiteWrite | undefined;
	if (input.fence) {
		const fenced = await applyFence(site.db);
		if (typeof fenced !== "function") return failure(fenced.code, fenced.message);
		recordWrite = fenced;
	}

	const canChangeAuthor = body.authorId !== undefined && hasPermission(user, "content:edit_any");
	const writeBody = canChangeAuthor ? body : { ...body, authorId: undefined };

	const result = await site.handleContentUpdate(collection, resolvedId, {
		...writeBody,
		locale,
		_rev: rev,
		actor: { id: user.id, role: user.role },
		editedBy: input.editedBy,
	});
	if (result.success) await recordWrite?.();
	return result;
}

/**
 * The values a fresh read gives an entry: its live values under the draft revision's, without
 * `_` keys, and the draft's staged slug, or else the live slug.
 */
export function overlayDraft(
	live: { data: Record<string, unknown>; slug: string | null },
	draft: Record<string, unknown> | null | undefined,
): Omit<ContentWrite, "rev"> {
	if (!draft) return { data: { ...live.data }, slug: live.slug };
	return {
		data: {
			...live.data,
			...Object.fromEntries(Object.entries(draft).filter(([key]) => !key.startsWith("_"))),
		},
		slug: typeof draft._slug === "string" ? draft._slug : live.slug,
	};
}

interface EditGrant {
	user: { id: string; role: RoleLevel };
	entryId: string;
	access: "full" | "draft";
	/** The `_rev` of the entry as checked. */
	checkedRev: string | undefined;
}

/** The checks a save makes before anything else: the entry exists and the user may edit it. */
async function checkEditAccess(
	site: ContentSaveSite,
	input: Pick<ContentSaveInput, "collection" | "id" | "locale" | "user">,
): Promise<EditGrant | ContentSaveError> {
	const { collection, id, locale, user } = input;
	const existing = await site.handleContentGet(collection, id, locale);
	if (!existing.success) {
		return {
			code: existing.error?.code ?? "UNKNOWN_ERROR",
			message: existing.error?.message ?? "Unknown error",
		};
	}

	const existingData =
		existing.data && typeof existing.data === "object"
			? // eslint-disable-next-line typescript/no-unsafe-type-assertion -- handler returns unknown data; narrowed by typeof check above
				(existing.data as Record<string, unknown>)
			: undefined;
	// Handler returns { item, _rev } — extract the item for ownership and ID resolution
	const existingItem =
		existingData?.item && typeof existingData.item === "object"
			? // eslint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by typeof check above
				(existingData.item as Record<string, unknown>)
			: existingData;
	const authorId = typeof existingItem?.authorId === "string" ? existingItem.authorId : "";
	const entry = { authorId, status: existingItem?.status };
	if (!user) return { code: "UNAUTHORIZED", message: "Authentication required" };
	const access = entryEditAccess(user, entry);
	if (!access) return { code: "FORBIDDEN", message: "Insufficient permissions" };
	return {
		user,
		entryId: typeof existingItem?.id === "string" ? existingItem.id : id,
		access,
		checkedRev: typeof existingData?._rev === "string" ? existingData._rev : undefined,
	};
}

/** Applies the site-write fence: the refusal, or the function that records the write. */
async function applyFence(db: Kysely<Database>): Promise<RecordSiteWrite | ContentSaveError> {
	try {
		return await assertSiteWriteAllowed(db);
	} catch (error) {
		if (error instanceof SiteWriteBlockedError) return { code: error.code, message: error.message };
		throw error;
	}
}

export interface KeptMarkInput {
	collection: string;
	/** Entry ID or slug. */
	id: string;
	/** The locale a slug resolves in. */
	locale?: string;
	/** The actor. Their current role decides access. */
	user: { id: string; role: RoleLevel } | null | undefined;
	/** The `_rev` the mark is conditioned on. */
	rev: string;
	/** Apply the site-write fence, as for {@link saveContent}. */
	fence?: boolean;
}

export type KeptMarkResult =
	| { success: true; saved: ContentWrite }
	| { success: false; error: ContentSaveError };

const ENTRY_NOT_FOUND: ContentSaveError = { code: "NOT_FOUND", message: "Content item not found" };

function revConflict(entry: ContentItem, rev: string): ContentSaveError | null {
	const check = validateRev(rev, entry);
	return check.valid ? null : { code: "CONFLICT", message: check.message };
}

/**
 * A kept save with no changes: marks the entry's draft revision kept if it is an autosave, with
 * the checks {@link saveContent} makes and the same `_rev` check. Creates no revision, runs no
 * hooks and leaves `_rev` as it is. `saved` holds the entry's `_rev` and stored values, shaped
 * as a save's own write.
 */
export async function markDraftKept(
	site: ContentSaveSite,
	input: KeptMarkInput,
): Promise<KeptMarkResult> {
	const grant = await checkEditAccess(site, input);
	if ("code" in grant) return { success: false, error: grant };

	let recordWrite: RecordSiteWrite | undefined;
	if (input.fence) {
		const fenced = await applyFence(site.db);
		if (typeof fenced !== "function") return { success: false, error: fenced };
		recordWrite = fenced;
	}

	const repo = new ContentRepository(site.db);
	const entry = await repo.findById(input.collection, grant.entryId);
	if (!entry) return { success: false, error: ENTRY_NOT_FOUND };
	const conflict = revConflict(entry, input.rev);
	if (conflict) return { success: false, error: conflict };
	const draft = entry.draftRevisionId
		? await new RevisionRepository(site.db).findById(entry.draftRevisionId)
		: null;
	if (entry.draftRevisionId && !draft) {
		throw new Error(`Draft revision not found: ${entry.draftRevisionId}`);
	}

	if (await repo.markDraftRevisionKept(input.collection, entry.id, entry)) {
		await recordWrite?.();
	} else {
		// Nothing was marked because the entry changed, or because its draft isn't an autosave.
		const current = await repo.findById(input.collection, entry.id);
		if (!current) return { success: false, error: ENTRY_NOT_FOUND };
		const changed = revConflict(current, input.rev);
		if (changed) return { success: false, error: changed };
	}
	return { success: true, saved: { rev: input.rev, ...overlayDraft(entry, draft?.data) } };
}
