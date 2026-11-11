/**
 * The co-editing room's shared data shapes and close codes. Dependency-free, so code that must
 * not load Yjs can import them.
 */

export type RoomAccess = "edit" | "view";

export const CLOSE_CODES = {
	/** Join again for a fresh token. */
	rejoin: 4400,
	/** Discard the replica, then join again. */
	reset: 4401,
	/** The entry is in Trash or gone. */
	deleted: 4402,
	/** The room can't take the socket here. Join again in 5 s. */
	busy: 4403,
} as const;

export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES];

/** A value outside the shared document, which saves on its own. */
export type OutsideValue = "seo" | "author" | "publishedAt" | "terms" | "bylines" | "references";

export type Notice =
	| { kind: "operation"; by: string }
	| { kind: "outside"; fields: string[] }
	| { kind: "values"; values: OutsideValue[] }
	| { kind: "refused"; code: string; message: string };

export type RoomMessage =
	| { type: "welcome"; lineage: string; access: RoomAccess; snapshot: Uint8Array }
	| { type: "save" }
	| { type: "checkpoint"; editedBy: string[]; rev: string; snapshot: Uint8Array }
	| { type: "notice"; notice: Notice };

/** One client's awareness state, in y-protocols' wire format. A null state removes the client. */
export interface AwarenessEntry {
	clientId: number;
	clock: number;
	state: Record<string, unknown> | null;
}

export type Message =
	| { type: "sync-step-1"; stateVector: Uint8Array }
	| { type: "sync-step-2"; update: Uint8Array }
	| { type: "sync-update"; update: Uint8Array }
	| {
			type: "awareness";
			entries: AwarenessEntry[];
			/** The y-protocols awareness update the entries were read from. */
			update: Uint8Array;
	  }
	| RoomMessage;
