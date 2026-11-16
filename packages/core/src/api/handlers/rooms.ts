/**
 * Co-editing room handlers: joining an entry's room, and recovery revisions.
 */

import { hasPermission, type RoleLevel } from "@emdash-cms/auth";
import type { Kysely } from "kysely";

import { ContentRepository } from "../../database/repositories/content.js";
import { EntryLockRepository } from "../../database/repositories/entry-locks.js";
import { RevisionRepository } from "../../database/repositories/revision.js";
import { EmDashValidationError, type ContentItem } from "../../database/repositories/types.js";
import type { Database } from "../../database/types.js";
import { resolveConfiguredLocale } from "../../i18n/config.js";
import { roomId, type RoomAccess, type RoomHost } from "../../rooms/types.js";
import { isMissingTableError } from "../../utils/db-errors.js";
import { entryEditAccess } from "../authorize.js";
import { ErrorCode } from "../errors.js";
import { encodeRev } from "../rev.js";
import type { RoomJoinBody } from "../schemas/rooms.js";
import type { ApiResult } from "../types.js";
import { entryLockedBy } from "./entry-lock.js";

const LOG = "[co-editing]";

export type RoomJoinResult =
	| { mode: "room"; url: string; token: string; access: RoomAccess }
	| { mode: "single-editor" }
	/** The room is at a connection limit. */
	| { mode: "read-only" };

/** What a join reads from the admin manifest. */
interface JoinManifest {
	version: string;
	commit?: string;
	hash: string;
	collections: Record<string, { supports: string[] }>;
}

export interface RoomJoinInput {
	collection: string;
	/** Entry ID or slug. */
	id: string;
	/** The locale a slug resolves in. */
	locale?: string;
	user: { id: string; role: RoleLevel; name: string | null; email: string } | null | undefined;
	body: RoomJoinBody;
	/** The admin manifest. The client's fingerprint must match its `version`, `commit` and `hash`. */
	getManifest: () => Promise<JoinManifest>;
	/** Rooms can't reach a playground session's database. */
	playground: boolean;
	/** The site's base path without a trailing slash. */
	basePath: string;
}

type Joiner = NonNullable<RoomJoinInput["user"]>;

function failure(code: string, message: string): ApiResult<never> {
	return { success: false, error: { code, message } };
}

const singleEditor = (): ApiResult<RoomJoinResult> => ({
	success: true,
	data: { mode: "single-editor" },
});

const roomBusy = () =>
	failure(ErrorCode.ROOM_BUSY, "The entry's room isn't available here right now. Join again soon.");

/** The join route's own path, where the client opens its socket. */
function roomUrl(basePath: string, collection: string, entryId: string): string {
	return `${basePath}/_emdash/api/content/${encodeURIComponent(collection)}/${encodeURIComponent(entryId)}/room`;
}

function findEntry(
	db: Kysely<Database>,
	input: Pick<RoomJoinInput, "collection" | "id" | "locale">,
	options: { includeTrashed: boolean },
): Promise<ContentItem | null> {
	const repo = new ContentRepository(db);
	const locale = input.locale ? resolveConfiguredLocale(input.locale) : undefined;
	return options.includeTrashed
		? repo.findByIdOrSlugIncludingTrashed(input.collection, input.id, locale)
		: repo.findByIdOrSlug(input.collection, input.id, locale);
}

/**
 * Joins the entry's room, or tells the client which mode to open in. `rooms` is null where
 * co-editing is off or the host can't run rooms.
 */
export async function handleRoomJoin(
	db: Kysely<Database>,
	rooms: RoomHost | null,
	input: RoomJoinInput,
): Promise<ApiResult<RoomJoinResult>> {
	try {
		const { user } = input;
		if (!user) return failure(ErrorCode.UNAUTHORIZED, "Authentication required");
		const first = await joinOnce(db, rooms, input, user);
		if (first !== "stale") return first;
		// The room refused the token because the entry's status or author changed since this
		// join checked access, so access is checked again against the entry as it is now.
		const second = await joinOnce(db, rooms, input, user);
		return second === "stale" ? roomBusy() : second;
	} catch (error) {
		if (isMissingTableError(error)) return failure(ErrorCode.NOT_FOUND, "Content item not found");
		console.error(`${LOG} join failed:`, error);
		return failure("ROOM_JOIN_ERROR", "Failed to join the room");
	}
}

async function joinOnce(
	db: Kysely<Database>,
	rooms: RoomHost | null,
	input: RoomJoinInput,
	user: Joiner,
): Promise<ApiResult<RoomJoinResult> | "stale"> {
	const entry = await findEntry(db, input, { includeTrashed: false });
	if (!entry) return failure(ErrorCode.NOT_FOUND, "Content item not found");
	if (!hasPermission(user, "content:read_drafts")) {
		return failure(ErrorCode.FORBIDDEN, "Insufficient permissions");
	}
	const room = roomId({ collection: input.collection, id: entry.id });

	if (!rooms || input.playground) return singleEditor();
	const manifest = await input.getManifest();
	if (!manifest.collections[input.collection]?.supports.includes("revisions")) {
		return singleEditor();
	}
	if (input.body.singleEditor) {
		await rooms.forgetTokens(room, user.id);
		console.warn(
			`${LOG} ${room}: a client's sockets didn't open, so it edits in single-editor mode`,
		);
		return singleEditor();
	}
	const locks = new EntryLockRepository(db);
	const lock = await locks.findLive(input.collection, entry.id);
	if (lock?.userId === user.id) return singleEditor();

	const editable = { authorId: entry.authorId ?? "", status: entry.status };
	const holder = lock ? await locks.findEnforceable(input.collection, entry.id) : null;
	if (holder && holder.userId !== user.id) {
		if (!input.body.takeover) {
			const refusal = entryLockedBy(holder);
			return {
				success: false,
				error: { code: refusal.code, message: refusal.message, details: { ...refusal.details } },
			};
		}
		if (!entryEditAccess(user, editable)) {
			return failure(ErrorCode.FORBIDDEN, "Insufficient permissions");
		}
	}

	const { version, commit, hash } = input.body.fingerprint;
	if (version !== manifest.version || commit !== manifest.commit || hash !== manifest.hash) {
		return failure(
			ErrorCode.CLIENT_OUTDATED,
			"The admin is out of date. Reload it to keep editing.",
		);
	}

	const access: RoomAccess = entryEditAccess(user, editable) ? "edit" : "view";
	const issued = await rooms.issueToken(room, {
		userId: user.id,
		name: user.name || user.email,
		access,
		fingerprint: { version, commit, hash },
		rev: encodeRev(entry),
		status: entry.status,
		authorId: entry.authorId,
	});
	if (issued === "stale") return "stale";
	if (issued === "busy") return roomBusy();
	if (issued === "full") return { success: true, data: { mode: "read-only" } };
	if (issued === null) return singleEditor();
	if (holder && holder.userId !== user.id) await locks.releaseEntry(input.collection, entry.id);
	return {
		success: true,
		data: {
			mode: "room",
			url: roomUrl(input.basePath, input.collection, entry.id),
			token: issued.token,
			access,
		},
	};
}

export interface RecoveryRevisionInput {
	collection: string;
	/** Entry ID or slug. */
	id: string;
	/** The locale a slug resolves in. */
	locale?: string;
	user: { id: string; role: RoleLevel } | null | undefined;
	/** The client's document fields. */
	data: Record<string, unknown>;
	slug: string | null;
}

/**
 * Stores a client's document as a recovery revision authored by the caller, for entries in Trash
 * too. Checks edit access but not edit locks or fields, so content from before a schema change
 * still saves, and moves neither the draft nor the live pointer.
 */
export async function handleRecoveryRevisionCreate(
	db: Kysely<Database>,
	input: RecoveryRevisionInput,
): Promise<ApiResult<{ id: string }>> {
	try {
		if (!input.user) return failure(ErrorCode.UNAUTHORIZED, "Authentication required");
		const entry = await findEntry(db, input, { includeTrashed: true });
		if (!entry) return failure(ErrorCode.NOT_FOUND, "Content item not found");
		if (!entryEditAccess(input.user, { authorId: entry.authorId ?? "", status: entry.status })) {
			return failure(ErrorCode.FORBIDDEN, "Insufficient permissions");
		}
		const revision = await new RevisionRepository(db).create({
			collection: input.collection,
			entryId: entry.id,
			data: { ...input.data, _slug: input.slug },
			authorId: input.user.id,
			kind: "recovery",
		});
		return { success: true, data: { id: revision.id } };
	} catch (error) {
		if (isMissingTableError(error)) return failure(ErrorCode.NOT_FOUND, "Content item not found");
		if (error instanceof EmDashValidationError) {
			return failure(ErrorCode.VALIDATION_ERROR, error.message);
		}
		console.error(`${LOG} recovery revision failed:`, error);
		return failure("RECOVERY_REVISION_ERROR", "Failed to save the recovery revision");
	}
}
