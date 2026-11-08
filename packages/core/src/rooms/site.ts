/**
 * The `RoomSite` over a runtime: how a room reads and saves its entry. Every call runs through
 * `run`, which gives it the runtime outside any request.
 */

import { toRoleLevel } from "@emdash-cms/auth";

import {
	markDraftKept,
	overlayDraft,
	saveContent,
	type ContentSaveError,
} from "../api/content-save.js";
import { encodeRev } from "../api/rev.js";
import { ContentRepository } from "../database/repositories/content.js";
import { RevisionRepository } from "../database/repositories/revision.js";
import type { EmDashRuntime } from "../emdash-runtime.js";
import { assertSiteWriteAllowed } from "../transfer/fence.js";
import { isMissingTableError } from "../utils/db-errors.js";
import { withRoomNotificationQueue } from "./notifications.js";
import {
	roomId,
	type CheckpointInput,
	type EntryRef,
	type LoadedEntry,
	type RecoveryInput,
	type RoomSite,
	type SaveResult,
} from "./types.js";

/** Runs a function with the site's runtime, outside any request. */
export type RunWithRuntime = <T>(fn: (runtime: EmDashRuntime) => Promise<T>) => Promise<T>;

const DRAFT_NOT_STAGED = "DRAFT_NOT_STAGED";

export function createRoomSite(run: RunWithRuntime): RoomSite {
	return {
		load: (entry) => run((runtime) => loadEntry(runtime, entry)),
		// The room's own writes don't notify it, but copies to sibling locales notify theirs.
		save: (entry, checkpoint) =>
			run((runtime) =>
				withRoomNotificationQueue(() => saveCheckpoint(runtime, entry, checkpoint), {
					skip: roomId(entry),
				}),
			),
		saveRecovery: (entry, recovery) => run((runtime) => saveRecovery(runtime, entry, recovery)),
	};
}

/** The row, in Trash too, or null when it or its collection is gone. */
async function findRow(runtime: EmDashRuntime, entry: EntryRef) {
	try {
		return await new ContentRepository(runtime.db).findByIdIncludingTrashed(
			entry.collection,
			entry.id,
		);
	} catch (error) {
		if (isMissingTableError(error)) return null;
		throw error;
	}
}

async function loadEntry(runtime: EmDashRuntime, entry: EntryRef): Promise<LoadedEntry | null> {
	const row = await findRow(runtime, entry);
	if (!row) return null;
	const draft = row.draftRevisionId
		? await new RevisionRepository(runtime.db).findById(row.draftRevisionId)
		: null;
	// Live values in place of a missing draft would make the room write them back as edits.
	if (row.draftRevisionId && !draft) {
		throw new Error(`Draft revision not found: ${row.draftRevisionId}`);
	}
	const collection = await runtime.schemaRegistry.getCollectionWithFields(entry.collection);
	if (!collection) return null;
	const manifest = await runtime.getManifest();
	return {
		rev: encodeRev(row),
		status: row.status,
		authorId: row.authorId,
		trashed: row.deletedAt !== null,
		...overlayDraft(row, draft?.data),
		fields: collection.fields.map((field) => ({
			slug: field.slug,
			type: field.type,
			validation: field.validation,
		})),
		hash: manifest.hash,
		// Every plugin's, enabled or not, as the admin builds its editor schema.
		pluginTypes: Object.values(manifest.plugins).flatMap(
			(plugin) => plugin.portableTextBlocks?.map((block) => block.type) ?? [],
		),
	};
}

async function saveCheckpoint(
	runtime: EmDashRuntime,
	entry: EntryRef,
	checkpoint: CheckpointInput,
): Promise<SaveResult> {
	const actor = await runtime.db
		.selectFrom("users")
		.select(["id", "role", "disabled"])
		.where("id", "=", checkpoint.actorId)
		.executeTakeFirst();
	if (!actor || actor.disabled) {
		return refused({ code: "FORBIDDEN", message: "The user can't edit this entry" });
	}
	const user = { id: actor.id, role: toRoleLevel(actor.role) };

	if (
		checkpoint.kept &&
		checkpoint.slug === undefined &&
		Object.keys(checkpoint.data).length === 0
	) {
		const marked = await markDraftKept(runtime, {
			collection: entry.collection,
			id: entry.id,
			user,
			rev: checkpoint.rev,
			fence: true,
		});
		return marked.success ? { ok: true, ...marked.saved } : refused(marked.error);
	}

	const result = await saveContent(runtime, {
		collection: entry.collection,
		id: entry.id,
		user,
		body: {
			data: checkpoint.data,
			...(checkpoint.slug === undefined ? {} : { slug: checkpoint.slug }),
			_rev: checkpoint.rev,
			skipRevision: !checkpoint.kept,
		},
		editedBy: checkpoint.editedBy,
		fence: true,
	});
	if (!result.success) {
		return refused(result.error ?? { code: "UNKNOWN_ERROR", message: "Unknown error" });
	}
	if (!result.saved) {
		return refused({
			code: DRAFT_NOT_STAGED,
			message: "The save didn't stage a draft revision",
		});
	}
	return { ok: true, ...result.saved };
}

function refused(error: ContentSaveError): SaveResult {
	return { ok: false, reason: reasonFor(error.code), code: error.code, message: error.message };
}

function reasonFor(code: string): Extract<SaveResult, { ok: false }>["reason"] {
	switch (code) {
		case "CONFLICT":
			return "CONFLICT";
		case "FORBIDDEN":
		case "UNAUTHORIZED":
			return "FORBIDDEN";
		case "NOT_FOUND":
			return "NOT_FOUND";
		default:
			return "REFUSED";
	}
}

/** Throws when the fence refuses, so the room keeps its state and tries again. */
async function saveRecovery(
	runtime: EmDashRuntime,
	entry: EntryRef,
	recovery: RecoveryInput,
): Promise<void> {
	const row = await findRow(runtime, entry);
	if (!row) return;
	const recordWrite = await assertSiteWriteAllowed(runtime.db);
	await new RevisionRepository(runtime.db).create({
		collection: entry.collection,
		entryId: row.id,
		data: { ...recovery.data, _slug: recovery.slug },
		kind: "recovery",
		editedBy: recovery.editedBy,
	});
	await recordWrite();
}
