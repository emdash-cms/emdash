import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { writeField } from "../../src/co-editing/layout";
import { decodeMessage, encodeUpdate } from "../../src/co-editing/protocol";
import { snapshotContains } from "../../src/co-editing/snapshot";
import { readPeers } from "../../src/lib/co-editing/replica/presence";
import type { RoomEditing } from "../../src/lib/co-editing/types";
import { LoopbackRoom, settle } from "./loopback-room";
import { resetTransportHealth, startSession, type TestSession } from "./session-harness";

let sessions: TestSession[] = [];

beforeEach(resetTransportHealth);
afterEach(() => {
	for (const { session } of sessions) session.dispose();
	sessions = [];
	resetTransportHealth();
});

async function join(room: LoopbackRoom): Promise<TestSession & { editing: RoomEditing }> {
	const session = startSession(room);
	sessions.push(session);
	await settle();
	const view = session.view();
	if (view.mode !== "room") throw new Error(`Expected a room, got ${view.mode}`);
	return Object.assign(session, { editing: view.room });
}

const covered = (editing: RoomEditing) => editing.getSaveState().covered;
const seed = (doc: Y.Doc) => {
	doc.getMap("fields").set("title", "Hello");
	doc.getText("notes").insert(0, "Some notes to delete from");
};

describe("coverage", () => {
	it("flips only on a checkpoint that contains the own last edit", async () => {
		const room = new LoopbackRoom({ seed });
		const a = await join(room);
		expect(covered(a.editing)).toBe(true);
		const before = room.snapshot();
		a.editing.fields.set({ title: "Changed" });
		expect(covered(a.editing)).toBe(false);
		await settle();
		room.checkpoint(before);
		await settle();
		expect(covered(a.editing)).toBe(false);
		room.checkpoint();
		await settle();
		expect(covered(a.editing)).toBe(true);
	});

	it("stays covered while a peer keeps typing and deleting", async () => {
		const room = new LoopbackRoom({ seed });
		const a = await join(room);
		a.editing.fields.set({ title: "Mine" });
		await settle();
		const holdingMine = room.snapshot();
		const peer = room.peer();
		for (let keystroke = 0; keystroke < 20; keystroke++) {
			peer.getText("notes").insert(0, "x");
			if (keystroke % 3 === 0) peer.getText("notes").delete(0, 2);
			await settle();
		}
		room.checkpoint(holdingMine);
		await settle();
		expect(covered(a.editing)).toBe(true);
		peer.getText("notes").delete(0, 4);
		peer.getMap("fields").set("summary", "Theirs");
		await settle();
		expect(covered(a.editing)).toBe(true);
	});

	it("counts an own edit that only deletes", async () => {
		const room = new LoopbackRoom({ seed });
		const a = await join(room);
		const before = room.snapshot();
		a.replica().doc.getText("notes").delete(0, 5);
		expect(covered(a.editing)).toBe(false);
		await settle();
		room.checkpoint(before);
		await settle();
		expect(covered(a.editing)).toBe(false);
		room.checkpoint();
		await settle();
		expect(covered(a.editing)).toBe(true);
	});

	it("covers an own delete a peer made at the same time, at the peer's checkpoint", async () => {
		const room = new LoopbackRoom({ seed, manual: true });
		const a = startSession(room);
		sessions.push(a);
		await settle();
		const socket = room.sockets[0]!;
		while (a.view().mode !== "room") if (!socket.pumpIn()) socket.pumpOut();
		room.peer().getText("notes").delete(0, 5);
		room.checkpoint();
		a.replica().doc.getText("notes").delete(0, 5);
		expect(covered(a.replica().editing)).toBe(false);
		while (socket.pumpIn());
		expect(covered(a.replica().editing)).toBe(true);
	});

	it("doesn't change on an echo of its own update", async () => {
		const room = new LoopbackRoom({ seed });
		const a = await join(room);
		const updates: Uint8Array[] = [];
		a.replica().doc.on("update", (update: Uint8Array) => updates.push(update));
		a.editing.fields.set({ title: "Echoed" });
		await settle();
		expect(covered(a.editing)).toBe(false);
		room.checkpoint();
		await settle();
		expect(covered(a.editing)).toBe(true);
		let notified = 0;
		a.editing.subscribe(() => notified++);
		for (const update of updates) room.live()[0]!.deliver(encodeUpdate(update));
		await settle();
		expect(covered(a.editing)).toBe(true);
		expect(notified).toBe(0);
	});

	it("survives a rejoin with the same replica", async () => {
		const room = new LoopbackRoom({ seed });
		const a = await join(room);
		a.editing.fields.set({ title: "Before the rejoin" });
		room.close(4400);
		await settle();
		expect(a.view().mode).toBe("room");
		expect(covered(a.editing)).toBe(false);
		room.checkpoint();
		await settle();
		expect(covered(a.editing)).toBe(true);
		a.replica().doc.getText("notes").delete(0, 3);
		await settle();
		const saved = room.snapshot();
		room.close(4400);
		room.checkpoint(saved);
		await settle();
		expect(covered(a.editing)).toBe(true);
	});

	it("matches the literal snapshot at the own last edit over random interleavings", async () => {
		for (let seedNumber = 1; seedNumber <= 120; seedNumber++) {
			const random = mulberry32(seedNumber);
			const room = new LoopbackRoom({ seed, manual: true });
			const a = startSession(room);
			await settle();
			const socket = room.sockets[0]!;
			let checkpoint: Y.Snapshot | null = null;
			let literal: Y.Snapshot | null = null;
			const pumpIn = () => {
				const next = socket.inbox[0];
				const message = next && decodeMessage(next);
				if (message?.type === "welcome" || message?.type === "checkpoint") {
					checkpoint = Y.decodeSnapshot(message.snapshot);
				}
				return socket.pumpIn();
			};
			while (a.view().mode !== "room") if (!pumpIn()) socket.pumpOut();
			const doc = a.replica().doc;
			doc.on("afterTransaction", (transaction: Y.Transaction) => {
				const id = doc.clientID;
				const edited =
					transaction.afterState.get(id) !== transaction.beforeState.get(id) ||
					transaction.deleteSet.clients.size > 0;
				if (transaction.local && edited) literal = Y.snapshot(doc);
			});
			const peer = room.peer();
			const pending: Y.Snapshot[] = [];
			for (let step = 0; step < 80; step++) {
				const roll = random();
				if (roll < 0.15) edit(doc.getText("notes"), random);
				else if (roll < 0.3) edit(peer.getText("notes"), random);
				else if (roll < 0.5) socket.pumpOut();
				else if (roll < 0.75) pumpIn();
				else if (roll < 0.87) pending.push(room.snapshot());
				else if (pending.length > 0) room.checkpoint(pending.shift());
				const expected =
					literal === null || (checkpoint !== null && snapshotContains(checkpoint, literal));
				expect(covered(a.replica().editing), `seed ${seedNumber}, step ${step}`).toBe(expected);
			}
			a.session.dispose();
		}
	});
});

describe("whenCovered", () => {
	it("resolves at once when covered, and never sends save unless asked", async () => {
		const room = new LoopbackRoom({ seed });
		const a = await join(room);
		await expect(a.editing.whenCovered({ save: true })).resolves.toBeUndefined();
		a.editing.fields.set({ title: "Preview me" });
		let resolved = false;
		void a.editing.whenCovered({ save: false }).then(() => (resolved = true));
		await settle();
		expect(a.editing.getSaveState().saving).toBe(true);
		expect(room.saves).toBe(0);
		room.checkpoint();
		await settle();
		expect(resolved).toBe(true);
		expect(room.saves).toBe(0);
		expect(a.editing.getSaveState()).toMatchObject({ covered: true, saving: false });
	});

	it("sends save when asked, and resolves on the checkpoint that covers the target", async () => {
		const room = new LoopbackRoom({ seed });
		const a = await join(room);
		a.editing.fields.set({ title: "Save me" });
		const before = room.snapshot();
		let resolved = false;
		void a.editing.whenCovered({ save: true }).then(() => (resolved = true));
		await settle();
		expect(room.saves).toBe(1);
		a.editing.fields.set({ title: "Typed after Save" });
		await settle();
		room.checkpoint(before);
		await settle();
		expect(resolved).toBe(false);
		const coveringTarget = room.snapshot();
		room.checkpoint(coveringTarget);
		await settle();
		expect(resolved).toBe(true);
	});

	it("sends a save asked during a short reconnect once live again", async () => {
		const room = new LoopbackRoom({ seed });
		const a = await join(room);
		a.editing.fields.set({ title: "Reconnecting" });
		room.close(4400);
		const waiting = a.editing.whenCovered({ save: true });
		expect(room.saves).toBe(0);
		await settle();
		expect(room.saves).toBe(1);
		room.checkpoint();
		await expect(waiting).resolves.toBeUndefined();
	});

	it("rejects on a refused save, after 30 s, and when the replica goes away", async () => {
		const room = new LoopbackRoom({ seed });
		const a = await join(room);
		a.editing.fields.set({ title: "" });
		const refused = a.editing.whenCovered({ save: true });
		room.notice({ kind: "refused", code: "VALIDATION_ERROR", message: "Title is required" });
		await expect(refused).rejects.toMatchObject({
			reason: "refused",
			code: "VALIDATION_ERROR",
			message: "Title is required",
		});
		const timedOut = a.editing.whenCovered({ save: true });
		a.clock.advance(29_999);
		await settle();
		expect(a.editing.getSaveState().saving).toBe(true);
		a.clock.advance(1);
		await expect(timedOut).rejects.toMatchObject({ reason: "timeout" });
		const gone = a.editing.whenCovered({ save: false });
		a.session.dispose();
		await expect(gone).rejects.toMatchObject({ reason: "gone" });
	});
});

describe("document values", () => {
	const body = [
		{
			_type: "block",
			_key: "b1",
			style: "normal",
			children: [{ _type: "span", _key: "s1", text: "Rich text" }],
		},
	];
	const seedEntry = (doc: Y.Doc) => {
		const fields = doc.getMap("fields");
		fields.set("title", "Hello");
		fields.set("slug", "hello-world");
		fields.set("tags", ["a", "b"]);
		fields.set("legacy", { kept: true });
		writeField(doc, { slug: "body", type: "portableText" }, body, [], null);
	};

	it("recovers every map value except the slug, and the pinned rich text, with the slug apart", async () => {
		const room = new LoopbackRoom({ seed: seedEntry });
		const a = await join(room);
		a.editing.fields.set({ title: "Edited" });
		expect(a.replica().recoveryInput()).toEqual({
			data: { title: "Edited", tags: ["a", "b"], legacy: { kept: true }, body },
			slug: "hello-world",
		});
	});

	it("reads a value another client nested as a shared type as empty, everywhere", async () => {
		const room = new LoopbackRoom({ seed: seedEntry });
		const a = await join(room);
		room
			.peer()
			.getMap("fields")
			.set("legacy", new Y.Map([["kept", true]]));
		await settle();

		expect(a.editing.fields.get("legacy")).toBeNull();
		expect(a.editing.fields.read(["title", "legacy"])).toEqual({ title: "Hello", legacy: null });
		expect(a.replica().recoveryInput()).toEqual({
			data: { title: "Hello", tags: ["a", "b"], body },
			slug: "hello-world",
		});
	});

	it("writes changed values in one transaction and skips equal ones", async () => {
		const room = new LoopbackRoom({ seed: seedEntry });
		const a = await join(room);
		const socket = room.live()[0]!;
		const sent = () => socket.received.filter((message) => message.type === "sync-update").length;
		a.editing.fields.set({ title: "Hello", tags: ["a", "b"] });
		await settle();
		expect(sent()).toBe(0);
		expect(covered(a.editing)).toBe(true);
		a.editing.fields.set({ title: "New", tags: ["c"], legacy: undefined });
		await settle();
		expect(sent()).toBe(1);
		expect(room.doc.getMap("fields").toJSON()).toMatchObject({ title: "New", tags: ["c"] });
		expect(room.doc.getMap("fields").has("legacy")).toBe(false);
	});

	it("reads each field once per change, and tells only that field's subscribers", async () => {
		const room = new LoopbackRoom({ seed: seedEntry });
		const a = await join(room);
		const { fields } = a.editing;
		const tags = fields.get("tags");
		expect(fields.get("tags")).toBe(tags);
		expect(fields.get("body")).toEqual(body);
		let titleChanges = 0;
		let tagChanges = 0;
		fields.subscribe("title", () => titleChanges++);
		fields.subscribe("tags", () => tagChanges++);
		room.peer().getMap("fields").set("title", "Theirs");
		await settle();
		expect([titleChanges, tagChanges]).toEqual([1, 0]);
		expect(fields.get("tags")).toBe(tags);
		expect(fields.get("title")).toBe("Theirs");
	});

	it("counts remote changes per field, and tells which fields changed since a capture", async () => {
		const room = new LoopbackRoom({ seed: seedEntry });
		const a = await join(room);
		const { editing } = a;
		const capture = editing.captureDraft(["title", "body"]);
		expect(capture.values).toEqual({ title: "Hello", body });
		const versions = () => ["tags", "body", "title"].map(editing.fields.remoteVersion);
		const [tags, bodyVersion, title] = versions();
		editing.fields.set({ tags: ["mine"] });
		expect(versions()).toEqual([tags, bodyVersion, title]);
		expect(editing.changedSince(capture, ["title", "body"])).toBe(false);
		expect(editing.changedSince(capture, ["tags"])).toBe(true);
		const peer = room.peer();
		writeField(peer, { slug: "body", type: "portableText" }, [], [], null);
		await settle();
		expect(versions()).toEqual([tags, bodyVersion! + 1, title]);
		expect(editing.changedSince(capture, ["body"])).toBe(true);
		const other = await join(room);
		expect(other.editing.changedSince(capture, ["title"])).toBe(true);
		room.checkpoint();
		await settle();
		expect(editing.captureDraft([]).rev).toMatch(/^rev-/);
	});

	it("reads the other clients the room stamped with a user", async () => {
		const room = new LoopbackRoom();
		const a = await join(room);
		const b = await join(room);
		b.replica().awareness.setLocalStateField("field", "title");
		await settle();
		expect(readPeers(a.replica().awareness)).toEqual([
			{
				clientId: b.replica().doc.clientID,
				user: { id: `user-${b.replica().doc.clientID}`, name: `User ${b.replica().doc.clientID}` },
				field: "title",
			},
		]);
		b.session.dispose();
		await settle();
		expect(readPeers(a.replica().awareness)).toEqual([]);
	});
});

function edit(text: Y.Text, random: () => number): void {
	const position = Math.floor(random() * (text.length + 1));
	if (random() < 0.45 && text.length > 0) {
		const at = Math.min(position, text.length - 1);
		text.delete(at, Math.min(1 + Math.floor(random() * 4), text.length - at));
	} else {
		text.insert(position, "abcdefgh".slice(0, 1 + Math.floor(random() * 8)));
	}
}

function mulberry32(seedNumber: number): () => number {
	let state = seedNumber;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
