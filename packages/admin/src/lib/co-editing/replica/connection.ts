import { applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";

import {
	decodeMessage,
	encodeAwareness,
	encodeRoomMessage,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeUpdate,
} from "../../../co-editing/protocol.js";
import type { RoomAccess, RoomMessage } from "../../../co-editing/types.js";
import type {
	ConnectionEvents,
	ConnectionHandle,
	ConnectionTarget,
	RoomSocket,
} from "../session.js";
import { REMOTE } from "./origins.js";
import type { Replica, SaveLink } from "./replica.js";

interface AwarenessChange {
	added: number[];
	updated: number[];
	removed: number[];
}

/**
 * One socket to the room. It answers the room's sync step 1 only for an editor, sends local
 * updates only after that answer, and sends presence only once synced. Nothing from the replica
 * goes out before `welcome` names its lineage: the room sends `welcome` and its own sync step 1
 * back to back, so another lineage's welcome closes the socket in the same handler.
 */
export class Connection implements ConnectionHandle, SaveLink {
	readonly #replica: Replica;
	readonly #events: ConnectionEvents;
	readonly #socket: RoomSocket;
	#opened = false;
	#closed = false;
	/** Set by an accepted `welcome`. */
	#access: RoomAccess | null = null;
	#sendingUpdates = false;
	#synced = false;

	constructor(
		replica: Replica,
		target: ConnectionTarget,
		events: ConnectionEvents,
		openSocket: (url: string) => RoomSocket,
	) {
		this.#replica = replica;
		this.#events = events;
		this.#socket = openSocket(socketUrl(target));
		this.#socket.binaryType = "arraybuffer";
		this.#socket.onopen = () => {
			this.#opened = true;
			this.#events.opened();
		};
		this.#socket.onmessage = (event) => this.#receive(event.data);
		this.#socket.onclose = (event) => {
			if (this.#closed) return;
			this.#shutdown();
			this.#events.closed(event.code, this.#opened);
		};
		replica.doc.on("update", this.#onUpdate);
		replica.awareness.on("update", this.#onAwareness);
	}

	close(): void {
		if (this.#closed) return;
		this.#shutdown();
		this.#socket.close();
	}

	save(): void {
		if (!this.#closed && this.#access === "edit") {
			this.#send(encodeRoomMessage({ type: "save" }));
		}
	}

	#receive(data: unknown): void {
		if (this.#closed || !(data instanceof ArrayBuffer)) return;
		const message = decodeMessage(new Uint8Array(data));
		if (!message) return;
		if (message.type === "welcome") {
			this.#welcome(message);
			return;
		}
		if (this.#access === null) return;
		const { doc } = this.#replica;
		switch (message.type) {
			case "sync-step-1":
				if (this.#access !== "edit") return;
				this.#send(encodeSyncStep2(doc, message.stateVector));
				this.#sendingUpdates = true;
				return;
			case "sync-step-2":
				Y.applyUpdate(doc, message.update, REMOTE);
				if (!this.#synced) this.#sync();
				return;
			case "sync-update":
				Y.applyUpdate(doc, message.update, REMOTE);
				return;
			case "awareness":
				applyAwarenessUpdate(this.#replica.awareness, message.update, REMOTE);
				return;
			case "checkpoint":
				this.#replica.checkpoint(message.snapshot, message.rev);
				this.#events.checkpoint(message.rev, message.editedBy);
				return;
			case "notice":
				if (message.notice.kind === "refused") {
					this.#replica.refused(message.notice.code, message.notice.message);
				}
				this.#events.notice(message.notice);
				return;
			case "save":
				return;
		}
	}

	#welcome(message: Extract<RoomMessage, { type: "welcome" }>): void {
		if (this.#access !== null) return;
		const lineage = this.#replica.lineage;
		if (lineage !== null && lineage !== message.lineage) {
			this.close();
			this.#events.welcome(message.lineage, message.access);
			return;
		}
		this.#access = message.access;
		this.#replica.welcome(message.lineage, message.access, message.snapshot);
		this.#events.welcome(message.lineage, message.access);
		// The session may have closed this connection: an editor's replica welcomed as a viewer.
		if (this.#closed) return;
		this.#send(encodeSyncStep1(this.#replica.doc));
	}

	#sync(): void {
		this.#synced = true;
		this.#replica.synced(this);
		this.#events.synced();
		if (this.#closed) return;
		// When a socket closes, the room tells the others this client left, at one past the clock
		// it held. Presence from the next socket must pass that clock, or peers ignore it.
		const { awareness } = this.#replica;
		const clock = awareness.meta.get(awareness.clientID)?.clock ?? 0;
		awareness.meta.set(awareness.clientID, { clock: clock + 2, lastUpdated: Date.now() });
		this.#sendPresence();
	}

	readonly #onUpdate = (update: Uint8Array, origin: unknown): void => {
		if (origin === REMOTE || !this.#sendingUpdates || this.#closed) return;
		this.#send(encodeUpdate(update));
	};

	readonly #onAwareness = (change: AwarenessChange, origin: unknown): void => {
		if (origin === REMOTE || !this.#synced || this.#closed) return;
		const own = this.#replica.awareness.clientID;
		if ([...change.added, ...change.updated, ...change.removed].includes(own)) {
			this.#sendPresence();
		}
	};

	#sendPresence(): void {
		const { awareness } = this.#replica;
		const clientId = awareness.clientID;
		const clock = awareness.meta.get(clientId)?.clock ?? 0;
		this.#send(encodeAwareness([{ clientId, clock, state: awareness.getLocalState() }]));
	}

	#send(bytes: Uint8Array): void {
		const { buffer, byteOffset, byteLength } = bytes;
		this.#socket.send(
			buffer instanceof ArrayBuffer
				? new Uint8Array(buffer, byteOffset, byteLength)
				: new Uint8Array(bytes),
		);
	}

	#shutdown(): void {
		this.#closed = true;
		this.#socket.onopen = null;
		this.#socket.onmessage = null;
		this.#socket.onclose = null;
		const { doc, awareness } = this.#replica;
		doc.off("update", this.#onUpdate);
		awareness.off("update", this.#onAwareness);
		this.#replica.detach(this);
		const remote = [...awareness.getStates().keys()].filter((id) => id !== awareness.clientID);
		if (remote.length > 0) removeAwarenessStates(awareness, remote, REMOTE);
		// The next room replays the others at the clocks it holds, which these would outrank.
		for (const id of awareness.meta.keys()) {
			if (id !== awareness.clientID) awareness.meta.delete(id);
		}
	}
}

/** `ws:` or `wss:` on the join's path, with the token. */
function socketUrl({ url, token }: ConnectionTarget): string {
	const address = new URL(url, location.href);
	address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
	address.searchParams.set("token", token);
	return address.href;
}
