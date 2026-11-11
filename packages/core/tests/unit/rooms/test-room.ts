/**
 * A room over the memory store and fake site, under fake timers, with bare `Y.Doc` clients that
 * speak the room protocol.
 */

import {
	readField,
	decodeMessage,
	encodeAwareness,
	encodeRoomMessage,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeUpdate,
	type AwarenessEntry,
	type Message,
	type Notice,
} from "@emdash-cms/admin/internal/co-editing";
import { vi } from "vitest";
import * as Y from "yjs";

import { type DocumentField } from "../../../src/rooms/document.js";
import { Room } from "../../../src/rooms/room.js";
import type {
	Build,
	ConnectionInfo,
	EntryRef,
	Fingerprint,
	RoomAccess,
	RoomConnection,
	RoomTimers,
	TokenClaims,
} from "../../../src/rooms/types.js";
import { FakeSite, type FakeEntryInit } from "./fake-site.js";
import { MemoryRoomStore } from "./memory-store.js";

export const ENTRY: EntryRef = { collection: "posts", id: "01ENTRY" };
export const BUILD: Build = { version: "1.0.0", commit: "abc123" };
export const FINGERPRINT: Fingerprint = { ...BUILD, hash: "schema-1" };
export const TITLE: DocumentField = { slug: "title", type: "string" };
export const BODY: DocumentField = { slug: "body", type: "portableText" };

const FROM_ROOM = Symbol("from-room");

export const roomTimers: RoomTimers = {
	now: () => Date.now(),
	set(ms, run) {
		const id = setTimeout(run, ms);
		return () => clearTimeout(id);
	},
};

/** Fakes only the clock and `setTimeout`, so `settle` can still drain promises. */
export function useRoomTimers(): void {
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "Date"],
		now: new Date("2026-11-04T12:00:00Z"),
	});
}

/** Lets queued tasks, store calls and site calls run, without moving the clock. */
export async function settle(): Promise<void> {
	for (let index = 0; index < 30; index++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

/** Moves the clock, firing timers, then settles. */
export async function advance(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	await settle();
}

export function paragraph(key: string, text: string) {
	return {
		_type: "block",
		_key: key,
		style: "normal",
		markDefs: [],
		children: [{ _type: "span", _key: `${key}s`, text, marks: [] }],
	};
}

/** The text of every span in Portable Text blocks, one block per line. */
export function blocksText(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value
		.map((block: { children?: Array<{ text?: string }> }) =>
			(block.children ?? []).map((child) => child.text ?? "").join(""),
		)
		.join("\n");
}

export class TestRoom {
	readonly site: FakeSite;
	readonly store = new MemoryRoomStore();
	room: Room;

	constructor(init: FakeEntryInit = {}) {
		this.site = new FakeSite({
			fields: [TITLE, BODY],
			data: { title: "Hello", body: [paragraph("a", "First paragraph.")] },
			...init,
		});
		this.site.notify = (outside) => this.room.notify(outside);
		this.room = this.#create(BUILD);
	}

	/**
	 * A new process: what the room didn't store is lost, and the old claim is gone. The old room's
	 * timers never fire and its store and site calls never settle. Sockets survive, as across
	 * hibernation, but reach only the new room.
	 */
	restart(build: Build = BUILD): Room {
		this.#process.dead = true;
		this.store.claimed = false;
		this.room = this.#create(build);
		return this.room;
	}

	claims(userId: string, overrides: Partial<TokenClaims> = {}): TokenClaims {
		const entry = this.site.current;
		return {
			userId,
			name: `Name ${userId}`,
			access: "edit",
			fingerprint: FINGERPRINT,
			rev: entry.rev,
			status: entry.status,
			authorId: entry.authorId,
			...overrides,
		};
	}

	/** Gets a token and connects a new client with it. */
	async join(userId: string, overrides: Partial<TokenClaims> = {}): Promise<TestClient> {
		const result = await this.room.issueToken(this.claims(userId, overrides));
		if (typeof result !== "object" || result === null) {
			throw new Error(`No token: ${String(result)}`);
		}
		const client = new TestClient(this, userId, overrides.access ?? "edit");
		client.connect(result.token);
		await settle();
		return client;
	}

	/** Gets a fresh token and reconnects a client that keeps its replica. */
	async rejoin(client: TestClient, overrides: Partial<TokenClaims> = {}): Promise<void> {
		const result = await this.room.issueToken(this.claims(client.userId, overrides));
		if (typeof result !== "object" || result === null) {
			throw new Error(`No token: ${String(result)}`);
		}
		client.closed = null;
		client.connect(result.token);
		await settle();
	}

	storedText(slug = BODY.slug): string {
		return blocksText(this.site.current.data[slug]);
	}

	#process = { dead: false };

	#create(build: Build): Room {
		const process = { dead: false };
		this.#process = process;
		const alive = <T>(call: () => Promise<T>): Promise<T> => {
			if (process.dead) return never();
			return call().then(
				(value) => (process.dead ? never() : value),
				(error: unknown) => (process.dead ? never() : Promise.reject(error)),
			);
		};
		const { site, store } = this;
		return new Room({
			entry: ENTRY,
			site: {
				load: (entry) => alive(() => site.load(entry)),
				save: (entry, input) => alive(() => site.save(entry, input)),
				saveRecovery: (entry, recovery) => alive(() => site.saveRecovery(entry, recovery)),
			},
			store: {
				load: () => alive(() => store.load()),
				append: (updates) => alive(() => store.append(updates)),
				writeRecord: (record, update) => alive(() => store.writeRecord(record, update)),
				compact: (state) => alive(() => store.compact(state)),
				drop: () => alive(() => store.drop()),
				touch: () => alive(() => store.touch()),
				claim: () => alive(() => store.claim()),
				renew: () => alive(() => store.renew()),
				release: () => alive(() => store.release()),
			},
			build,
			timers: {
				now: roomTimers.now,
				set: (ms, run) =>
					roomTimers.set(ms, () => {
						if (!process.dead) run();
					}),
			},
		});
	}
}

const never = <T>(): Promise<T> => new Promise<T>(() => {});

export class TestClient implements RoomConnection {
	doc = new Y.Doc();
	received: Message[] = [];
	closed: { code: number; reason: string } | null = null;
	lineage: string | null = null;
	readonly #test: TestRoom;

	constructor(
		test: TestRoom,
		readonly userId: string,
		readonly access: RoomAccess = "edit",
	) {
		this.#test = test;
		this.doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin === FROM_ROOM) return;
			if (this.#held) this.#held.push(encodeUpdate(update));
			else this.toRoom(encodeUpdate(update));
		});
	}

	#held: Uint8Array[] | null = null;

	/** Holds local updates instead of sending them. */
	hold(): void {
		this.#held ??= [];
	}

	/** Sends the held updates. */
	sendHeld(): void {
		const held = this.#held ?? [];
		this.#held = null;
		for (const message of held) this.toRoom(message);
	}

	/** Applies an update that reached this replica some other way, without sending it on. */
	applyFromPeer(update: Uint8Array): void {
		Y.applyUpdate(this.doc, update, FROM_ROOM);
	}

	send(bytes: Uint8Array): void {
		const message = decodeMessage(bytes);
		if (!message) throw new Error("The room sent a message that doesn't decode");
		this.received.push(message);
		if (message.type === "sync-step-1") {
			queueMicrotask(() => this.toRoom(encodeSyncStep2(this.doc, message.stateVector)));
		} else if (message.type === "sync-step-2" || message.type === "sync-update") {
			Y.applyUpdate(this.doc, message.update, FROM_ROOM);
		} else if (message.type === "welcome") {
			this.lineage = message.lineage;
		}
	}

	close(code: number, reason: string): void {
		this.closed ??= { code, reason };
	}

	connect(token: string): ConnectionInfo | null {
		const info = this.#test.room.connect(this, token);
		this.toRoom(encodeSyncStep1(this.doc));
		return info;
	}

	toRoom(bytes: Uint8Array): void {
		if (!this.closed) this.#test.room.receive(this, bytes);
	}

	disconnect(): void {
		this.closed ??= { code: 1000, reason: "closed" };
		this.#test.room.disconnect(this);
	}

	requestSave(): void {
		this.toRoom(encodeRoomMessage({ type: "save" }));
	}

	announce(entries: AwarenessEntry[]): void {
		this.toRoom(encodeAwareness(entries));
	}

	setField(slug: string, value: unknown): void {
		this.doc.getMap("fields").set(slug, value);
	}

	field(slug: string): unknown {
		return this.doc.getMap("fields").get(slug);
	}

	/** Types at the start of a rich-text block. */
	type(text: string, slug = BODY.slug, block = 0): void {
		const element = this.doc.getXmlFragment(`field:${slug}`).get(block);
		if (!(element instanceof Y.XmlElement)) throw new Error(`No block ${block} in ${slug}`);
		const first = element.get(0);
		if (first instanceof Y.XmlText) {
			first.insert(0, text);
		} else {
			const node = new Y.XmlText();
			node.insert(0, text);
			element.insert(0, [node]);
		}
	}

	text(slug = BODY.slug): string {
		return blocksText(readField(this.doc, { slug, type: "portableText" }));
	}

	notices(): Notice[] {
		return this.received.flatMap((message) => (message.type === "notice" ? [message.notice] : []));
	}

	checkpoints(): Array<Extract<Message, { type: "checkpoint" }>> {
		return this.received.flatMap((message) => (message.type === "checkpoint" ? [message] : []));
	}

	awareness(): AwarenessEntry[] {
		return this.received.flatMap((message) =>
			message.type === "awareness" ? message.entries : [],
		);
	}
}
