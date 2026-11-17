/**
 * What the editor page sees of a co-editing session. Transport, lineage and tokens stay inside the
 * session.
 */

import type { AnyExtension } from "@tiptap/core";

import type { OutsideValue, RoomAccess } from "../../co-editing/types.js";
import type { AuthorColor } from "../author-colors.js";

/** The session's mode, as the page renders it. */
export type CoEditing =
	| {
			/** No synced replica yet: a join or connection is in flight, or a retry is due. */
			readonly mode: "pending";
			/** A retry is scheduled, after the room was busy or full or the network dropped. */
			readonly waiting: boolean;
	  }
	| {
			readonly mode: "room";
			readonly room: RoomEditing;
			readonly access: RoomAccess;
			readonly editable: boolean;
			/** Disconnected for 5 s or more. */
			readonly offline: boolean;
			/** With `offline`: the browser still has a network connection, so the server can't be reached. */
			readonly unreachable: boolean;
			/** Disconnected for good. The edits stay in the tab, but none are sent. */
			readonly kept: "access" | "deleted" | "recovery-failed" | null;
			/** Reloads the admin, from `kept`. */
			reload(): void;
			/** The manifest the session started with, which the room's fields and blocks come from. */
			readonly manifest: import("../api/client.js").AdminManifest;
	  }
	| {
			readonly mode: "single-editor";
			/** False once the browser session is pinned to single-editor mode. */
			readonly canJoin: boolean;
			/** The room closed or turned the join away because the entry went to Trash or is gone. */
			readonly deleted: boolean;
			/**
			 * Joins again with `takeover`, for **Take over** and **Join** alike. Calls `fallback`, the
			 * edit lock's own takeover, if the join still answers single-editor mode, or if the admin is
			 * out of date and `unsaved` says the form holds edits a reload would lose.
			 */
			takeOver(fallback: () => void, options?: { unsaved?: boolean }): void;
	  }
	| { readonly mode: "reloading" };

/** One synced replica of the entry's shared document. A reset replaces it, with a new `id`. */
export interface RoomEditing {
	readonly id: string;
	readonly fields: RoomFields;
	subscribe(listener: () => void): () => void;
	/** The same object until the save state changes. */
	getSaveState(): RoomSaveState;
	/**
	 * Resolves once a checkpoint covers this tab's edits, at once if one does. Sends `save` first
	 * only when `save` is true, which makes a kept checkpoint. Rejects with `RoomSaveError`.
	 */
	whenCovered(options: { save: boolean }): Promise<void>;
	/** The binding the field's rich-text editor mounts with, the same object on every call. */
	richText(field: string): RichTextBinding;
	captureDraft(fields: readonly string[]): DraftCapture;
	/** True when one of `fields` changed after the capture, by anyone, or the capture is another replica's. */
	changedSince(capture: DraftCapture, fields: readonly string[]): boolean;
	/**
	 * Writes a plugin's editor-draft patch in one transaction, which each bound rich-text editor
	 * undoes in one step. Writes nothing and returns false for rich text the editor can't represent.
	 */
	applyPatch(values: Readonly<Record<string, unknown>>): boolean;
	readonly presence: RoomPresence;
}

/** Who else is in the room, and where. */
export interface RoomPresence {
	/**
	 * The user this tab belongs to. Colors are assigned over everyone present, this user included,
	 * so every client gives each person the same color.
	 */
	setSelf(userId: string | null): void;
	subscribe(listener: () => void): () => void;
	/**
	 * The other people in the room, once each and in the order they joined, or only those in
	 * `field`. The same array until someone joins, leaves, renames or changes field: a cursor
	 * moving never changes it.
	 */
	getUsers(field?: string): readonly PresenceUser[];
}

/** Another person in the room. */
export interface PresenceUser {
	readonly id: string;
	readonly name: string;
	readonly color: AuthorColor;
	/** The field one of their tabs is in, or null for a viewer or someone in none. */
	readonly field: string | null;
}

/** The document's field values, and the entry slug under `slug`. */
export interface RoomFields {
	subscribe(field: string, listener: () => void): () => void;
	/** A copy, made once per change. Rich text reads as Portable Text. */
	get(field: string): unknown;
	/**
	 * Writes every changed value in one transaction. `undefined` removes a value. Writes nothing
	 * and returns false for rich text the editor can't represent.
	 */
	set(values: Readonly<Record<string, unknown>>): boolean;
	read(fields: readonly string[]): Record<string, unknown>;
	/** Counts the changes other clients made to the field. */
	remoteVersion(field: string): number;
}

export interface RoomSaveState {
	/** The last checkpoint contains this tab's own last edit: "Saved". */
	readonly covered: boolean;
	/** A `whenCovered` call is waiting for a checkpoint. */
	readonly saving: boolean;
	/** The latest checkpoint's `_rev`, once one arrives. */
	readonly rev: string | null;
}

export interface DraftCapture {
	readonly values: Record<string, unknown>;
	readonly rev: string | null;
	readonly sequence: number;
	readonly replica: string;
}

/** Built by the co-editing chunk and read once when a rich-text editor mounts. */
export interface RichTextBinding {
	readonly extensions: readonly AnyExtension[];
}

/** Another client in the room, as its awareness state says. Viewers have no field. */
export interface PresencePeer {
	readonly clientId: number;
	readonly user: { readonly id: string; readonly name: string };
	readonly field: string | null;
}

/** What the page applies to its query cache and shows as toasts. */
export type RoomEvent =
	| { readonly kind: "values"; readonly values: readonly OutsideValue[] }
	| { readonly kind: "outside"; readonly fields: readonly string[] }
	| { readonly kind: "operation"; readonly by: string }
	| { readonly kind: "refused"; readonly code: string; readonly message: string }
	| { readonly kind: "checkpoint"; readonly rev: string; readonly editedBy: readonly string[] }
	/** The tab is live again after a disconnection. Saves made meanwhile sent it no checkpoint. */
	| { readonly kind: "reconnected" }
	/** A reset saved this tab's uncovered edits as a recovery revision. */
	| { readonly kind: "recovered" }
	/** A Take over or Join found the admin out of date, and stayed to keep the form's edits. */
	| { readonly kind: "outdated" };

export type RoomSaveFailure = "offline" | "access" | "refused" | "gone" | "timeout";

/** Why `whenCovered` gave up. A refused save carries the room's code and message. */
export class RoomSaveError extends Error {
	constructor(
		readonly reason: RoomSaveFailure,
		readonly code?: string,
		message: string = reason,
	) {
		super(message);
		this.name = "RoomSaveError";
	}
}
