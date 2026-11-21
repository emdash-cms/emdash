/**
 * A co-editing room in the test page, on the shared protocol: it sends `welcome` and then its own
 * sync step 1 to editors, answers sync step 1, applies editors' updates and relays every update
 * and awareness change to every socket, the sender included, as the real room does.
 */

import * as Y from "yjs";

import {
	decodeMessage,
	encodeAwareness,
	encodeRoomMessage,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeUpdate,
} from "../../src/co-editing/protocol";
import { snapshotContains } from "../../src/co-editing/snapshot";
import type { AwarenessEntry, Message, Notice, RoomAccess } from "../../src/co-editing/types";
import type { RoomSocket } from "../../src/lib/co-editing/session";

type Handler<K extends "onopen" | "onmessage" | "onclose"> = WebSocket[K];

export class FakeSocket implements RoomSocket {
	binaryType: BinaryType = "blob";
	onopen: Handler<"onopen"> = null;
	onmessage: Handler<"onmessage"> = null;
	onclose: Handler<"onclose"> = null;
	open = false;
	closed = false;
	clientId: number | null = null;
	/** Every message the client sent, decoded. */
	readonly received: Message[] = [];
	/** Room-to-client and client-to-room messages not yet delivered, in manual mode. */
	readonly inbox: Uint8Array[] = [];
	readonly outbox: Uint8Array[] = [];

	constructor(
		readonly room: LoopbackRoom,
		readonly url: string,
		readonly access: RoomAccess,
	) {}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		if (this.closed || !ArrayBuffer.isView(data)) return;
		this.outbox.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
		if (!this.room.manual) queueMicrotask(() => this.pumpOut());
	}

	/** As a browser does, reports the close it starts, unless its handler is gone. */
	close(): void {
		if (this.closed) return;
		const code = this.open ? 1005 : 1006;
		this.closed = true;
		this.room.drop(this);
		queueMicrotask(() => this.onclose?.call(this as never, new CloseEvent("close", { code })));
	}

	/** Delivers the oldest room-to-client message. */
	pumpIn(): boolean {
		const bytes = this.inbox.shift();
		if (!bytes) return false;
		if (!this.closed) {
			this.onmessage?.call(this as never, new MessageEvent("message", { data: bytes.buffer }));
		}
		return true;
	}

	/** Delivers the oldest client-to-room message. */
	pumpOut(): boolean {
		const bytes = this.outbox.shift();
		if (!bytes) return false;
		if (!this.closed) this.room.receive(this, bytes);
		return true;
	}

	deliver(bytes: Uint8Array): void {
		this.inbox.push(bytes);
		if (!this.room.manual) queueMicrotask(() => this.pumpIn());
	}

	/** The room closes the socket. Without `opened`, it never opened, as a blocking proxy does. */
	serverClose(code: number): void {
		if (this.closed) return;
		this.closed = true;
		this.room.drop(this);
		queueMicrotask(() => this.onclose?.call(this as never, new CloseEvent("close", { code })));
	}
}

export class LoopbackRoom {
	doc = new Y.Doc();
	lineage: string;
	/** The access the next socket gets. */
	access: RoomAccess = "edit";
	/** Sockets to refuse before they open. */
	refuse = 0;
	/** New sockets stay connecting. */
	stall = false;
	/** `save` messages from editors. */
	saves = 0;
	readonly sockets: FakeSocket[] = [];
	#checkpoint: Y.Snapshot;
	#rev = 0;
	readonly #presence = new Map<number, AwarenessEntry>();
	/** Messages wait in each socket's queues until pumped. */
	readonly manual: boolean;

	constructor(options: { lineage?: string; seed?: (doc: Y.Doc) => void; manual?: boolean } = {}) {
		this.manual = options.manual ?? false;
		this.lineage = options.lineage ?? "lineage-1";
		this.#checkpoint = this.#reset(options.seed);
	}

	readonly open = (url: string): FakeSocket => {
		const socket = new FakeSocket(this, url, this.access);
		this.sockets.push(socket);
		if (this.refuse > 0) {
			this.refuse--;
			socket.serverClose(1006);
			return socket;
		}
		queueMicrotask(() => {
			if (socket.closed || this.stall) return;
			socket.open = true;
			socket.onopen?.call(socket as never, new Event("open"));
			socket.deliver(
				encodeRoomMessage({
					type: "welcome",
					lineage: this.lineage,
					access: socket.access,
					snapshot: Y.encodeSnapshot(this.#checkpoint),
				}),
			);
			if (socket.access === "edit") socket.deliver(encodeSyncStep1(this.doc));
			if (this.#presence.size > 0) socket.deliver(encodeAwareness([...this.#presence.values()]));
		});
		return socket;
	};

	/** The room starts over with a new document and lineage, closing every socket with `rejoin`. */
	restart(lineage: string, seed?: (doc: Y.Doc) => void): void {
		this.close(4400);
		this.lineage = lineage;
		this.#checkpoint = this.#reset(seed);
	}

	snapshot(): Y.Snapshot {
		return Y.snapshot(this.doc);
	}

	/** Broadcasts a checkpoint, by default of the document as it is now. */
	checkpoint(snapshot = this.snapshot(), editedBy: string[] = []): string {
		if (!snapshotContains(snapshot, this.#checkpoint)) throw new Error("Checkpoints only grow");
		this.#checkpoint = snapshot;
		const rev = `rev-${++this.#rev}`;
		this.#broadcast(
			encodeRoomMessage({
				type: "checkpoint",
				editedBy,
				rev,
				snapshot: Y.encodeSnapshot(snapshot),
			}),
		);
		return rev;
	}

	notice(notice: Notice): void {
		this.#broadcast(encodeRoomMessage({ type: "notice", notice }));
	}

	close(code: number): void {
		for (const socket of this.live()) socket.serverClose(code);
	}

	live(): FakeSocket[] {
		return this.sockets.filter((socket) => socket.open && !socket.closed);
	}

	/** A peer document wired straight to the room, with no delay either way. */
	peer(): Y.Doc {
		const peer = new Y.Doc();
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(this.doc));
		peer.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin !== this) Y.applyUpdate(this.doc, update, peer);
		});
		this.doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin !== peer) Y.applyUpdate(peer, update, this);
		});
		return peer;
	}

	receive(socket: FakeSocket, bytes: Uint8Array): void {
		const message = decodeMessage(bytes);
		if (!message) throw new Error("The client sent a message that doesn't decode");
		socket.received.push(message);
		switch (message.type) {
			case "sync-step-1":
				socket.deliver(encodeSyncStep2(this.doc, message.stateVector));
				return;
			case "sync-step-2":
			case "sync-update":
				if (socket.access === "edit") Y.applyUpdate(this.doc, message.update, socket);
				return;
			case "awareness":
				for (const entry of message.entries) {
					socket.clientId ??= entry.clientId;
					if (entry.clientId !== socket.clientId) continue;
					const user = { id: `user-${entry.clientId}`, name: `User ${entry.clientId}` };
					const state = socket.access === "edit" ? { ...entry.state, user } : { user };
					const stamped = { clientId: entry.clientId, clock: entry.clock, state };
					this.#presence.set(entry.clientId, stamped);
					this.#broadcast(encodeAwareness([stamped]));
				}
				return;
			case "save":
				if (socket.access === "edit") this.saves++;
				return;
			default:
				return;
		}
	}

	drop(socket: FakeSocket): void {
		const held = socket.clientId === null ? undefined : this.#presence.get(socket.clientId);
		if (!held) return;
		this.#presence.delete(held.clientId);
		const removal = { clientId: held.clientId, clock: held.clock + 1, state: null };
		this.#broadcast(encodeAwareness([removal]));
	}

	#broadcast(bytes: Uint8Array): void {
		for (const socket of this.live()) socket.deliver(bytes);
	}

	#reset(seed?: (doc: Y.Doc) => void): Y.Snapshot {
		this.doc = new Y.Doc();
		seed?.(this.doc);
		this.doc.on("update", (update: Uint8Array) => this.#broadcast(encodeUpdate(update)));
		return Y.snapshot(this.doc);
	}
}

/** Lets queued messages, promise chains and zero-delay timers run. */
export async function settle(): Promise<void> {
	for (let round = 0; round < 5; round++) await new Promise((resolve) => setTimeout(resolve, 0));
}
