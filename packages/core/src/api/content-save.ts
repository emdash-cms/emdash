/**
 * The content save steps: the edit check, an optional lock check, an optional
 * site-write fence, and the runtime update. The content `PUT` route saves
 * through them, and so does any other caller that saves as a user.
 */

import { hasPermission, type RoleLevel } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import type { z } from "zod";

import type { EmDashHandlers, HandlerResponse } from "../astro/types.js";
import type { Database } from "../database/types.js";
import {
	assertSiteWriteAllowed,
	SiteWriteBlockedError,
	type RecordSiteWrite,
} from "../transfer/fence.js";
import { entryEditAccess } from "./authorize.js";
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
	const { collection, id, locale, user, body } = input;

	const existing = await site.handleContentGet(collection, id, locale);
	if (!existing.success) {
		return failure(
			existing.error?.code ?? "UNKNOWN_ERROR",
			existing.error?.message ?? "Unknown error",
		);
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
	if (!user) return failure("UNAUTHORIZED", "Authentication required");
	const access = entryEditAccess(user, entry);
	if (!access) return failure("FORBIDDEN", "Insufficient permissions");
	// A draft-only grant covers the entry only while it is a draft. Conditioning
	// the save on the checked revision makes it fail if the entry is published
	// between this check and the write.
	const checkedRev = typeof existingData?._rev === "string" ? existingData._rev : undefined;
	const rev = access === "draft" ? (body._rev ?? checkedRev) : body._rev;

	// Only EDITOR+ can write publishedAt directly — incl. clearing to null.
	if (body.publishedAt !== undefined && !hasPermission(user, "content:publish_any")) {
		return failure("FORBIDDEN", "Writing publishedAt requires content:publish_any permission");
	}

	const resolvedId = typeof existingItem?.id === "string" ? existingItem.id : id;

	const refusal = await input.beforeWrite?.(resolvedId);
	if (refusal) return { success: false, error: refusal };

	let recordWrite: RecordSiteWrite | undefined;
	if (input.fence) {
		try {
			recordWrite = await assertSiteWriteAllowed(site.db);
		} catch (error) {
			if (error instanceof SiteWriteBlockedError) return failure(error.code, error.message);
			throw error;
		}
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
