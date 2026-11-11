/**
 * The co-editing room's boundaries and data shapes. The host boundaries are
 * internal and can change until co-editing is stable.
 */

import type {
	CloseCode,
	OutsideValue,
	RoomAccess,
} from "@emdash-cms/admin/internal/co-editing/types";

import type { ContentWrite } from "../api/content-save.js";
import type { FieldType, FieldValidation } from "../schema/types.js";

export { CLOSE_CODES } from "@emdash-cms/admin/internal/co-editing/types";
export type {
	CloseCode,
	OutsideValue,
	RoomAccess,
} from "@emdash-cms/admin/internal/co-editing/types";

export type EntryRef = { collection: string; id: string };

/** The room's ID on Node.js: `{collection}:{entry ID}`. Collection slugs can't contain `:`. */
export function roomId(entry: EntryRef): string {
	return `${entry.collection}:${entry.id}`;
}

const ROOM_PATH = /\/_emdash\/api\/content\/([^/]+)\/([^/]+)\/room$/;

/**
 * The room ID a room upgrade path is for, `/_emdash/api/content/{collection}/{id}/room` under any
 * base path, or null when it isn't one.
 */
export function roomIdFromPath(pathname: string): string | null {
	const match = ROOM_PATH.exec(pathname);
	if (!match) return null;
	try {
		return roomId({
			collection: decodeURIComponent(match[1] ?? ""),
			id: decodeURIComponent(match[2] ?? ""),
		});
	} catch {
		return null;
	}
}

/** The entry a room ID names, or null when it isn't one. */
export function parseRoomId(id: string): EntryRef | null {
	const colon = id.indexOf(":");
	if (colon <= 0 || colon === id.length - 1) return null;
	return { collection: id.slice(0, colon), id: id.slice(colon + 1) };
}

/** A room token's random bytes. The token is their base64url encoding, without padding. */
export const ROOM_TOKEN_BYTES = 32;
const ROOM_TOKEN_LENGTH = Math.ceil((ROOM_TOKEN_BYTES * 4) / 3);
const BASE64URL = /^[\w-]*$/;

/** Whether a string has the shape of a token a room issues. */
export function isRoomToken(token: string): boolean {
	return token.length === ROOM_TOKEN_LENGTH && BASE64URL.test(token);
}

/** An EmDash build and its editor schema: the admin manifest's `version`, `commit` and `hash`. */
export interface Fingerprint {
	version: string;
	commit: string;
	hash: string;
}

/** The build a room runs. Tokens from another build get single-editor mode. */
export interface Build {
	version: string;
	commit: string;
}

/** Called by routes and the write path. */
export interface RoomHost {
	/**
	 * Stores first. Resolves to null when the room can't store, runs another build than the
	 * token's, or won't run for the entry; to "full" when a connection limit is reached; to
	 * "stale" when the entry's status or author changed since the route checked access; and to
	 * "busy" when another Node.js process holds the room's claim or this process is shutting down.
	 */
	issueToken(
		roomId: string,
		claims: TokenClaims,
	): Promise<{ token: string } | "full" | "stale" | "busy" | null>;
	/** Whether the room is open. On Node.js, also while another process holds its claim. */
	isOpen(roomId: string): Promise<boolean>;
	/**
	 * Waits for any other hold, saves a kept checkpoint as `actorId`, and holds other saves and
	 * merges until `release`. With `rev`, resolves to "conflict" and does neither if `rev` isn't
	 * the stored entry's or the room holds uncovered updates. Resolves to null when the room
	 * isn't open or runs in another Node.js process, and rejects with the save's error when the
	 * save fails.
	 */
	save(
		roomId: string,
		actorId: string,
		rev?: string,
	): Promise<{ rev: string; hold: string } | "conflict" | null>;
	/**
	 * Ends the hold. With `overwrite`, the room writes every field whose stored value differs
	 * from the kept checkpoint's, whatever the document holds.
	 */
	release(roomId: string, hold: string, options?: { overwrite?: boolean }): Promise<void>;
	/**
	 * Queues a merge of the stored entry and returns at once. `outside` names the values outside
	 * the document that the write changed, for clients to reload.
	 */
	notify(roomId: string, outside: OutsideValue[]): Promise<void>;
	/** Forgets the user's unused tokens, for a client that falls back to single-editor mode. */
	forgetTokens(roomId: string, userId: string): Promise<void>;
}

/** The host a runtime keeps, or null where co-editing is off or the host can't run rooms. */
export interface RuntimeRoomHost extends RoomHost {
	/** The hourly drop for rooms that aren't open. */
	expireIdle(): Promise<void>;
	/** Stores, saves, releases claims and closes every connection. */
	shutdown(): Promise<void>;
	/** Makes this the host notifications and upgrades reach. Called once the runtime is published. */
	activate(): void;
}

export interface TokenClaims {
	userId: string;
	name: string;
	access: RoomAccess;
	fingerprint: Fingerprint;
	/** The entry's `_rev`, status and author when the join route checked access. */
	rev: string;
	status: string;
	authorId: string | null;
}

/** Called by a room. */
export interface RoomSite {
	/**
	 * Loads entries in Trash too, marked as trashed, with the manifest `hash` and the inputs the
	 * shared editor schema takes. Resolves to null when the entry is gone.
	 */
	load(entry: EntryRef): Promise<LoadedEntry | null>;
	/**
	 * Resolves to the `_rev` and stored values of this save's own write. With empty `data`, no
	 * `slug` and `kept: true`, marks the current draft revision kept after the same `_rev`
	 * check, creates no revision, runs no hooks, and resolves to the same `_rev`. A rejection
	 * counts as `REFUSED`.
	 */
	save(entry: EntryRef, checkpoint: CheckpointInput): Promise<SaveResult>;
	/** Also saves for entries in Trash. */
	saveRecovery(entry: EntryRef, recovery: RecoveryInput): Promise<void>;
}

/** Room storage for one room. */
export interface RoomStore {
	/**
	 * Updates come in the order they were written, so the first is the initial or compacted state.
	 * `updatedAt` is the time in ms of the last write or `touch`, or null when nothing is stored.
	 */
	load(): Promise<{ record: RoomRecord | null; updates: Uint8Array[]; updatedAt: number | null }>;
	append(updates: Uint8Array[]): Promise<void>;
	writeRecord(record: RoomRecord, update?: Uint8Array): Promise<void>;
	/** Replaces every stored update with one state, in one transaction. */
	compact(state: Uint8Array): Promise<void>;
	drop(): Promise<void>;
	/** Records a closed connection, which restarts the stored state's hour. */
	touch(): Promise<void>;
	/**
	 * Node.js claims; on Workers, `claim` and `renew` resolve to true. `claim` takes the room if no
	 * live claim holds it, and the room loads after it. Every other method except `release` first
	 * renews this process's claim in its transaction: `renew` resolves to false, and the others
	 * reject with {@link RoomClaimLostError}, when the claim isn't this process's. `release`
	 * clears the claim only if it is this process's.
	 */
	claim(): Promise<boolean>;
	renew(): Promise<boolean>;
	release(): Promise<void>;
}

export interface LoadedEntry {
	rev: string;
	status: string;
	authorId: string | null;
	trashed: boolean;
	/** The draft revision's staged slug, or else the live slug. */
	slug: string | null;
	data: Record<string, unknown>;
	fields: Array<{ slug: string; type: FieldType; validation?: FieldValidation | null }>;
	/** The admin manifest hash. */
	hash: string;
	/** Block types plugins register, which the shared editor schema takes. */
	pluginTypes: string[];
}

export interface CheckpointInput {
	actorId: string;
	/** The merge base's `_rev`. */
	rev: string;
	/** Only the fields whose hash differs from the merge base's document hash. */
	data: Record<string, unknown>;
	/** Only when its hash differs. Null clears it. */
	slug?: string | null;
	/** False saves with `skipRevision: true`. */
	kept: boolean;
	/** Latest first. */
	editedBy: string[];
}

export type SaveResult =
	| ({ ok: true } & ContentWrite)
	| {
			ok: false;
			/** `UNAUTHORIZED` maps to `FORBIDDEN`, and a rejected save to `REFUSED`. */
			reason: "CONFLICT" | "FORBIDDEN" | "NOT_FOUND" | "REFUSED";
			/** The original error code, for `notice.refused`. */
			code: string;
			message: string;
	  };

export interface RecoveryInput {
	/** Every field in the document. */
	data: Record<string, unknown>;
	slug: string | null;
	editedBy: string[];
}

/**
 * The stored entry's `_rev` and each value's hash in the stored entry and in the document, as of
 * the last checkpoint or merge. Keys are field slugs, and `"slug"` for the entry slug, which no
 * field can use because it is reserved.
 */
export interface MergeBase {
	rev: string;
	stored: Record<string, string>;
	/** Null when both sides changed the value: the next save sends the document's. */
	document: Record<string, string | null>;
}

export interface RoomRecord {
	/** The continuous room state's random ID. */
	lineage: string;
	fingerprint: Fingerprint;
	/** The last checkpoint: base64 of `Y.encodeSnapshot`. */
	checkpoint: string;
	mergeBase: MergeBase;
	/** Users with updates the last checkpoint doesn't contain, latest first. */
	editors: string[];
	/** The entry's status and author when the room last loaded it. */
	status: string;
	authorId: string | null;
}

/** A socket, from the host. */
export interface RoomConnection {
	send(message: Uint8Array): void;
	close(code: CloseCode, reason: string): void;
}

/** Plain data, so a Durable Object can keep it in a socket attachment across hibernation. */
export interface ConnectionInfo {
	userId: string;
	name: string;
	access: RoomAccess;
	connectedAt: number;
	/** The first awareness client ID the connection announced. */
	clientId: number | null;
}

/** Timers, from the host. */
export interface RoomTimers {
	now(): number;
	/** Returns a function that cancels the timer. */
	set(ms: number, run: () => void): () => void;
}

/** A store method found the room's claim isn't this process's. */
export class RoomClaimLostError extends Error {
	constructor(message = "The room's claim belongs to another process") {
		super(message);
		this.name = "RoomClaimLostError";
	}
}

/** An operation's save failed. `reason` and `code` are the site's, `INVALID_CONTENT` or `UNLOADED`. */
export class RoomSaveError extends Error {
	readonly reason: string;
	readonly code: string;

	constructor(reason: string, code: string, message: string) {
		super(message);
		this.name = "RoomSaveError";
		this.reason = reason;
		this.code = code;
	}
}
