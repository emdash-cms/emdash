import type { Awareness } from "y-protocols/awareness";

import { assignAuthorColors, authorColorOf, type AuthorColor } from "../../author-colors.js";
import type { PresencePeer, PresenceUser, RoomPresence } from "../types.js";

/** The page marks the element that holds a room's fields with the replica's `id`. */
const ROOM_ATTRIBUTE = "data-co-editing-room";
/** The page marks each field's element with the field's name. */
const FIELD_ATTRIBUTE = "data-co-editing-field";

const NO_USERS: readonly PresenceUser[] = Object.freeze([]);

/**
 * The other clients in the room, in the order they joined. The room stamps each state's `user`
 * from its token, so a state without one isn't a client the room let in.
 */
export function readPeers(awareness: Awareness): PresencePeer[] {
	const peers: PresencePeer[] = [];
	for (const [clientId, state] of awareness.getStates()) {
		if (clientId === awareness.clientID) continue;
		const user: unknown = state.user;
		if (!isRecord(user) || typeof user.id !== "string" || typeof user.name !== "string") continue;
		const field = typeof state.field === "string" ? state.field : null;
		peers.push({ clientId, user: { id: user.id, name: user.name }, field });
	}
	return peers;
}

/**
 * The room's presence as the page reads it. Every awareness change re-reads the peers, but
 * listeners hear only of a change to who is here and in which field, so the many awareness
 * changes a moving cursor makes cost the page nothing.
 */
export class Presence implements RoomPresence {
	readonly #awareness: Awareness;
	readonly #listeners = new Set<() => void>();
	#self: string | null = null;
	#peers: readonly PresencePeer[] = [];
	#colors: ReadonlyMap<string, AuthorColor> = new Map();
	#users: readonly PresenceUser[] = NO_USERS;
	#byField: ReadonlyMap<string, readonly PresenceUser[]> = new Map();

	constructor(awareness: Awareness) {
		this.#awareness = awareness;
		awareness.on("change", this.#read);
	}

	/** The color of each user present, this tab's user included. A new map only when one changes. */
	get colors(): ReadonlyMap<string, AuthorColor> {
		return this.#colors;
	}

	colorOf(userId: string | null | undefined): AuthorColor {
		return authorColorOf(this.#colors, userId);
	}

	setSelf(userId: string | null): void {
		if (userId === this.#self) return;
		this.#self = userId;
		this.#update(this.#peers);
	}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	readonly getUsers = (field?: string): readonly PresenceUser[] => {
		if (field === undefined) return this.#users;
		return this.#byField.get(field) ?? NO_USERS;
	};

	dispose(): void {
		this.#awareness.off("change", this.#read);
		this.#listeners.clear();
	}

	readonly #read = (): void => {
		const peers = readPeers(this.#awareness);
		if (!samePeers(peers, this.#peers)) this.#update(peers);
	};

	#update(peers: readonly PresencePeer[]): void {
		this.#peers = peers;
		const colors = assignAuthorColors([this.#self, ...peers.map((peer) => peer.user.id)]);
		const users = new Map<string, PresenceUser>();
		const fields = new Map<string, Map<string, PresenceUser>>();
		for (const { user, field } of peers) {
			if (user.id === this.#self) continue;
			const color = authorColorOf(colors, user.id);
			const known = users.get(user.id);
			if (!known || (known.field === null && field !== null)) {
				users.set(user.id, { id: user.id, name: user.name, color, field });
			}
			if (field === null) continue;
			let inField = fields.get(field);
			if (!inField) fields.set(field, (inField = new Map()));
			if (!inField.has(user.id))
				inField.set(user.id, { id: user.id, name: user.name, color, field });
		}
		const nextUsers = keep(this.#users, [...users.values()]);
		const nextByField = new Map<string, readonly PresenceUser[]>();
		for (const [field, inField] of fields) {
			nextByField.set(field, keep(this.#byField.get(field) ?? NO_USERS, [...inField.values()]));
		}
		const changed =
			nextUsers !== this.#users ||
			nextByField.size !== this.#byField.size ||
			[...nextByField].some(([field, inField]) => this.#byField.get(field) !== inField);
		const colorsChanged = !sameColors(colors, this.#colors);
		if (colorsChanged) this.#colors = colors;
		this.#users = nextUsers;
		this.#byField = nextByField;
		if (changed || colorsChanged) for (const listener of this.#listeners) listener();
	}
}

/**
 * Keeps the awareness `field` on the field of this room that has focus, and null anywhere else.
 * Focus leaving the window keeps it, as it keeps the rich-text caret.
 */
export function trackFocusedField(awareness: Awareness, roomId: string): () => void {
	if (typeof document === "undefined") return () => {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const sync = () => {
		const field = focusedField(document.activeElement, roomId);
		const current: unknown = awareness.getLocalState()?.field ?? null;
		if (current !== field) awareness.setLocalStateField("field", field);
	};
	// Focus moving between fields passes through the body: read where it settled.
	const settle = () => {
		clearTimeout(timer);
		timer = setTimeout(sync, 0);
	};
	document.addEventListener("focusin", sync);
	document.addEventListener("focusout", settle);
	sync();
	return () => {
		clearTimeout(timer);
		document.removeEventListener("focusin", sync);
		document.removeEventListener("focusout", settle);
	};
}

function focusedField(element: Element | null, roomId: string): string | null {
	const field = element?.closest(`[${FIELD_ATTRIBUTE}]`);
	if (!field || field.closest(`[${ROOM_ATTRIBUTE}]`)?.getAttribute(ROOM_ATTRIBUTE) !== roomId) {
		return null;
	}
	return field.getAttribute(FIELD_ATTRIBUTE);
}

/** `previous` when `next` holds the same people, so readers keep one array. */
function keep(
	previous: readonly PresenceUser[],
	next: readonly PresenceUser[],
): readonly PresenceUser[] {
	if (next.length === 0) return NO_USERS;
	const same =
		previous.length === next.length &&
		next.every((user, index) => {
			const other = previous[index];
			return (
				other !== undefined &&
				other.id === user.id &&
				other.name === user.name &&
				other.color === user.color &&
				other.field === user.field
			);
		});
	return same ? previous : next;
}

function samePeers(a: readonly PresencePeer[], b: readonly PresencePeer[]): boolean {
	return (
		a.length === b.length &&
		a.every((peer, index) => {
			const other = b[index];
			return (
				other !== undefined &&
				other.clientId === peer.clientId &&
				other.user.id === peer.user.id &&
				other.user.name === peer.user.name &&
				other.field === peer.field
			);
		})
	);
}

function sameColors(a: ReadonlyMap<string, AuthorColor>, b: ReadonlyMap<string, AuthorColor>) {
	return a.size === b.size && [...a].every(([id, color]) => b.get(id) === color);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
