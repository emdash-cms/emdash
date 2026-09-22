import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import { EntryLockRepository, type EntryLock } from "../../database/repositories/entry-locks.js";
import type { Database } from "../../database/types.js";
import { ErrorCode } from "../errors.js";
import type { ApiResult } from "../types.js";

/**
 * How long an entry stays locked without a heartbeat or save. Long enough to
 * survive a pause in typing, short enough that a closed tab frees the entry
 * within a coffee break.
 */
export const ENTRY_LOCK_LEASE_MS = 7 * 60 * 1000;

const ENTRY_LOCK_LEASE_SECONDS = ENTRY_LOCK_LEASE_MS / 1000;

export interface EntryLockHolder {
	userId: string;
	userName: string | null;
	acquiredAt: string;
	expiresAt: string;
}

export interface EntryLockStatus {
	/** Whether the collection takes edit locks at all. */
	enabled: boolean;
	/** The live lease, whoever holds it. */
	holder: EntryLockHolder | null;
	/** Whether `holder` is the caller. */
	heldByCaller: boolean;
}

export interface EntryLockRefusal {
	code: typeof ErrorCode.ENTRY_LOCKED;
	message: string;
	details: EntryLockHolder;
}

function toHolder(lock: EntryLock): EntryLockHolder {
	return {
		userId: lock.userId,
		userName: lock.userName,
		acquiredAt: lock.acquiredAt,
		expiresAt: lock.expiresAt,
	};
}

function holderLabel(holder: EntryLockHolder): string {
	return holder.userName?.trim() ? holder.userName : "Another editor";
}

async function isLockingEnabled(db: Kysely<Database>, collection: string): Promise<boolean | null> {
	const row = await db
		.selectFrom("_emdash_collections")
		.select("edit_locking")
		.where("slug", "=", collection)
		.executeTakeFirst();
	if (!row) return null;
	return row.edit_locking !== 0;
}

function collectionNotFound(collection: string): ApiResult<never> {
	return {
		success: false,
		error: {
			code: ErrorCode.COLLECTION_NOT_FOUND,
			message: `Collection '${collection}' not found`,
		},
	};
}

/**
 * Takes the entry's lock for `userId`, or reports who is holding it. A
 * take-over is only granted when the caller asks for one.
 */
export async function handleEntryLockAcquire(
	db: Kysely<Database>,
	collection: string,
	entryId: string,
	userId: string,
	options: { takeover?: boolean; token?: string } = {},
): Promise<ApiResult<EntryLockStatus>> {
	try {
		const enabled = await isLockingEnabled(db, collection);
		if (enabled === null) return collectionNotFound(collection);
		if (!enabled) {
			return { success: true, data: { enabled: false, holder: null, heldByCaller: false } };
		}

		const claim = await new EntryLockRepository(db).acquire({
			collection,
			entryId,
			userId,
			token: options.token ?? ulid(),
			leaseSeconds: ENTRY_LOCK_LEASE_SECONDS,
			takeover: options.takeover,
		});

		return {
			success: true,
			data: {
				enabled: true,
				holder: toHolder(claim.lock),
				heldByCaller: claim.outcome === "acquired",
			},
		};
	} catch (error) {
		console.error("[entry-lock] acquire failed:", error);
		return {
			success: false,
			error: { code: ErrorCode.ENTRY_LOCK_ERROR, message: "Failed to acquire the entry lock" },
		};
	}
}

export async function handleEntryLockRead(
	db: Kysely<Database>,
	collection: string,
	entryId: string,
	userId: string,
): Promise<ApiResult<EntryLockStatus>> {
	try {
		const enabled = await isLockingEnabled(db, collection);
		if (enabled === null) return collectionNotFound(collection);
		if (!enabled) {
			return { success: true, data: { enabled: false, holder: null, heldByCaller: false } };
		}

		const lock = await new EntryLockRepository(db).findLive(collection, entryId);
		return {
			success: true,
			data: {
				enabled: true,
				holder: lock ? toHolder(lock) : null,
				heldByCaller: lock?.userId === userId,
			},
		};
	} catch (error) {
		console.error("[entry-lock] read failed:", error);
		return {
			success: false,
			error: { code: ErrorCode.ENTRY_LOCK_ERROR, message: "Failed to read the entry lock" },
		};
	}
}

export async function handleEntryLockRelease(
	db: Kysely<Database>,
	collection: string,
	entryId: string,
	userId: string,
	options: { token?: string } = {},
): Promise<ApiResult<{ released: boolean }>> {
	try {
		const released = await new EntryLockRepository(db).release({
			collection,
			entryId,
			userId,
			token: options.token,
		});
		return { success: true, data: { released } };
	} catch (error) {
		console.error("[entry-lock] release failed:", error);
		return {
			success: false,
			error: { code: ErrorCode.ENTRY_LOCK_ERROR, message: "Failed to release the entry lock" },
		};
	}
}

/**
 * Decides whether a write may proceed, and keeps the caller's own lease alive
 * while it does. Resolves to `null` when the write is allowed.
 *
 * A write never takes a lock it was not given, so a CLI or API caller writing
 * an unlocked entry leaves it unlocked.
 */
export async function claimEntryLockForWrite(
	db: Kysely<Database>,
	collection: string,
	entryId: string,
	userId: string,
	options: { override?: boolean } = {},
): Promise<EntryLockRefusal | null> {
	if (options.override === true) return null;

	const repo = new EntryLockRepository(db);
	const heldByCaller = await repo.refreshHeld({
		collection,
		entryId,
		userId,
		leaseSeconds: ENTRY_LOCK_LEASE_SECONDS,
	});
	if (heldByCaller) return null;

	const holder = await repo.findEnforceable(collection, entryId);
	if (!holder) return null;

	const details = toHolder(holder);
	return {
		code: ErrorCode.ENTRY_LOCKED,
		message: `${holderLabel(details)} is holding this entry`,
		details,
	};
}
