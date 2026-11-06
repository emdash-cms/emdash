/**
 * What the editor page sees of a co-editing session. Transport, lineage and tokens stay inside the
 * session.
 */

import type { AnyExtension } from "@tiptap/core";

import type { OutsideValue, RoomAccess } from "../../co-editing/types.js";

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
			/** Operations can run: connected with edit access. */
			readonly canOperate: boolean;
			/** Disconnected for 5 s or more. */
			readonly offline: boolean;
			/** Disconnected for good. The edits stay in the tab, but none are sent. */
			readonly kept: "access" | "deleted" | "recovery-failed" | null;
			/** Reloads the admin, from `kept`. */
			reload(): void;
	  }
	| {
			readonly mode: "single-editor";
			/** False once the browser session is pinned to single-editor mode. */
			readonly canJoin: boolean;
			/**
			 * Joins again with `takeover`, for **Take over** and **Join** alike. Calls `fallback`, the
			 * edit lock's own takeover, if the join still answers single-editor mode.
			 */
			takeOver(fallback: () => void): void;
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
	captureDraft(fields: readonly string[]): DraftCapture;
	/** True when one of `fields` changed after the capture, by anyone, or the capture is another replica's. */
	changedSince(capture: DraftCapture, fields: readonly string[]): boolean;
}

/** The document's field values, and the entry slug under `slug`. */
export interface RoomFields {
	subscribe(field: string, listener: () => void): () => void;
	/** A copy, made once per change. Rich text reads as Portable Text. */
	get(field: string): unknown;
	/** Writes every changed value in one transaction. `undefined` removes a value. */
	set(values: Readonly<Record<string, unknown>>): void;
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

/** Another client in the room. Viewers have no field. */
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
	/** A reset saved this tab's uncovered edits as a recovery revision. */
	| { readonly kind: "recovered" }
	/** The tab left its room for single-editor mode. */
	| { readonly kind: "left-room" };

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
