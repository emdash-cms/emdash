/**
 * Clients that join an `EmDashRoom` Durable Object through its RPC and WebSocket upgrades, as the
 * Worker does, with bare `Y.Doc` replicas that speak the room protocol.
 */

import {
	readField,
	decodeMessage,
	encodeAwareness,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeUpdate,
	type AwarenessEntry,
	type Message,
} from "@emdash-cms/admin/internal/co-editing";
import { env } from "cloudflare:workers";
import { COMMIT, VERSION } from "emdash/internal/co-editing";
import { expect, vi } from "vitest";
import * as Y from "yjs";

import type { EmDashRoom } from "../../../cloudflare/src/rooms/object.js";
import { type DocumentField } from "../../src/rooms/document.js";
import { roomId, type EntryRef, type TokenClaims } from "../../src/rooms/types.js";
import { FakeSite } from "../unit/rooms/fake-site.js";
import { setRoomSite } from "./fixtures/plugin-storage-worker.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		EMDASH_ROOMS: DurableObjectNamespace<EmDashRoom>;
	}
}

export const TITLE: DocumentField = { slug: "title", type: "string" };
export const BODY: DocumentField = { slug: "body", type: "portableText" };
const HASH = "schema-1";
const FROM_ROOM = Symbol("from-room");

let rooms = 0;

/** A room for a new entry, with a fake site for it. */
export function newRoom(): {
	entry: EntryRef;
	site: FakeSite;
	stub: DurableObjectStub<EmDashRoom>;
} {
	const entry: EntryRef = { collection: "posts", id: `01ENTRY${++rooms}${Date.now()}` };
	const site = new FakeSite({
		fields: [TITLE, BODY],
		data: { title: "Hello", body: [paragraph("a", "First paragraph.")] },
		hash: HASH,
	});
	setRoomSite(site);
	return { entry, site, stub: env.EMDASH_ROOMS.getByName(roomId(entry)) };
}

export function claims(site: FakeSite, userId: string): TokenClaims {
	const entry = site.current;
	return {
		userId,
		name: `Name ${userId}`,
		access: "edit",
		fingerprint: { version: VERSION, commit: COMMIT, hash: HASH },
		rev: entry.rev,
		status: entry.status,
		authorId: entry.authorId,
	};
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

export function blocksText(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value
		.map((block: { children?: Array<{ text?: string }> }) =>
			(block.children ?? []).map((child) => child.text ?? "").join(""),
		)
		.join("\n");
}

export class RoomClient {
	readonly doc = new Y.Doc();
	readonly received: Message[] = [];
	closed: { code: number } | null = null;
	#ws: WebSocket | null = null;

	constructor(readonly userId: string) {
		this.doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin !== FROM_ROOM) this.send(encodeUpdate(update));
		});
	}

	/** Gets a token through RPC and connects through a WebSocket upgrade. */
	static async join(
		stub: DurableObjectStub<EmDashRoom>,
		site: FakeSite,
		userId: string,
	): Promise<RoomClient> {
		const client = new RoomClient(userId);
		await client.connect(stub, site);
		return client;
	}

	async connect(stub: DurableObjectStub<EmDashRoom>, site: FakeSite): Promise<void> {
		const result = await stub.issueToken(claims(site, this.userId));
		if (typeof result !== "object" || result === null) {
			throw new Error(`No token: ${String(result)}`);
		}
		await this.upgrade(stub, result.token);
		await vi.waitFor(() => expect(this.received.some((m) => m.type === "welcome")).toBe(true));
	}

	async upgrade(stub: DurableObjectStub<EmDashRoom>, token: string): Promise<void> {
		this.closed = null;
		const response = await stub.fetch(
			`https://site.test/_emdash/api/content/posts/entry/room?token=${token}`,
			{ headers: { Upgrade: "websocket" } },
		);
		const ws = response.webSocket;
		if (response.status !== 101 || !ws) throw new Error(`No upgrade: ${response.status}`);
		ws.binaryType = "arraybuffer";
		ws.accept();
		ws.addEventListener("message", (event) => {
			if (event.data instanceof ArrayBuffer) this.#receive(new Uint8Array(event.data));
		});
		ws.addEventListener("close", (event) => {
			this.closed ??= { code: event.code };
		});
		this.#ws = ws;
		this.send(encodeSyncStep1(this.doc));
	}

	send(message: Uint8Array | string): void {
		if (!this.closed) this.#ws?.send(message);
	}

	close(): void {
		this.#ws?.close(1000, "done");
		this.closed ??= { code: 1000 };
	}

	announce(entries: AwarenessEntry[]): void {
		this.send(encodeAwareness(entries));
	}

	type(text: string, block = 0): void {
		const element = this.doc.getXmlFragment(`field:${BODY.slug}`).get(block);
		if (!(element instanceof Y.XmlElement)) throw new Error(`No block ${block}`);
		const first = element.get(0);
		if (first instanceof Y.XmlText) first.insert(0, text);
		else throw new Error("The block has no text");
	}

	setField(slug: string, value: unknown): void {
		this.doc.getMap("fields").set(slug, value);
	}

	text(): string {
		return blocksText(readField(this.doc, BODY));
	}

	awareness(): AwarenessEntry[] {
		return this.received.flatMap((m) => (m.type === "awareness" ? m.entries : []));
	}

	#receive(bytes: Uint8Array): void {
		const message = decodeMessage(bytes);
		if (!message) throw new Error("The room sent a message that doesn't decode");
		this.received.push(message);
		if (message.type === "sync-step-1") {
			this.send(encodeSyncStep2(this.doc, message.stateVector));
		} else if (message.type === "sync-step-2" || message.type === "sync-update") {
			Y.applyUpdate(this.doc, message.update, FROM_ROOM);
		}
	}
}
