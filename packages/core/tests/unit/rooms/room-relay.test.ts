import {
	readField,
	encodeRoomMessage,
	encodeSyncStep2,
	encodeUpdate,
} from "@emdash-cms/admin/internal/co-editing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { CLOSE_CODES } from "../../../src/rooms/types.js";
import { advance, BODY, settle, TestRoom, useRoomTimers, type TestClient } from "./test-room.js";

beforeEach(useRoomTimers);
afterEach(() => {
	vi.useRealTimers();
});

function updates(client: TestClient): number {
	return client.received.filter((message) => message.type === "sync-update").length;
}

describe("relay", () => {
	it("relays each applied update to every connection, the sender included", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const ben = await test.join("ben");
		const viewer = await test.join("vic", { access: "view" });
		const before = [ana, ben, viewer].map(updates);
		ana.type("Hi ");
		await settle();
		expect([ana, ben, viewer].map(updates)).toEqual(before.map((count) => count + 1));
		expect(ben.text()).toBe("Hi First paragraph.");
		expect(viewer.text()).toBe("Hi First paragraph.");
	});

	it("gets an update that unblocks another client's pending structs to every replica", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const ben = await test.join("ben");
		const cat = await test.join("cat");
		ana.hold();
		ana.type("Ana ");
		ben.applyFromPeer(Y.encodeStateAsUpdate(ana.doc, Y.encodeStateVector(ben.doc)));
		ben.type("Ben ");
		await settle();
		expect(cat.text()).toBe("First paragraph.");
		ana.sendHeld();
		await settle();
		const room = "Ben Ana First paragraph.";
		for (const client of [ana, ben, cat]) expect(client.text()).toBe(room);
		await advance(2000);
		expect(test.storedText()).toBe(room);
	});

	it("ignores everything but sync step 1 and awareness from viewers", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const viewer = await test.join("vic", { access: "view" });
		const doc = new Y.Doc();
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(ana.doc));
		doc.getMap("fields").set("title", "Viewer's title");
		const update = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(ana.doc));
		viewer.toRoom(encodeUpdate(update));
		viewer.toRoom(encodeSyncStep2(doc, Y.encodeStateVector(ana.doc)));
		viewer.toRoom(encodeRoomMessage({ type: "save" }));
		await advance(2000);
		expect(ana.field("title")).toBe("Hello");
		expect(test.site.saves).toHaveLength(0);
		expect(viewer.closed).toBeNull();
	});

	it("closes with reset on an update over 1 MB or one that doesn't apply", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const ben = await test.join("ben");
		const doc = new Y.Doc();
		doc.getMap("fields").set("title", "x".repeat(1_100_000));
		ana.toRoom(encodeUpdate(Y.encodeStateAsUpdate(doc)));
		expect(ana.closed?.code).toBe(CLOSE_CODES.reset);
		ben.toRoom(encodeUpdate(new Uint8Array([200, 1, 2, 3])));
		expect(ben.closed?.code).toBe(CLOSE_CODES.reset);
	});

	it("credits the user whose sync step 2 changes the document", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const doc = new Y.Doc();
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(ana.doc));
		const ben = await test.join("ben");
		expect(test.store.record?.editors).toEqual([]);
		doc.getMap("fields").set("title", "Ben's");
		ben.toRoom(encodeSyncStep2(doc, Y.encodeStateVector(ana.doc)));
		await advance(2000);
		expect(test.site.saves).toMatchObject([{ actorId: "ben", data: { title: "Ben's" } }]);
		expect(readField(ana.doc, BODY)).toEqual(readField(ben.doc, BODY));
	});
});

describe("awareness", () => {
	it("relays to every connection with the token's user, and sends viewers' names only", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const viewer = await test.join("vic", { access: "view" });
		ana.announce([{ clientId: 7, clock: 1, state: { cursor: 3, user: { id: "eve" } } }]);
		viewer.announce([{ clientId: 9, clock: 1, state: { cursor: 5 } }]);
		const expected = [
			{ clientId: 7, clock: 1, state: { cursor: 3, user: { id: "ana", name: "Name ana" } } },
			{ clientId: 9, clock: 1, state: { user: { id: "vic", name: "Name vic" } } },
		];
		expect(ana.awareness()).toEqual(expected);
		expect(viewer.awareness()).toEqual(expected);
		const late = await test.join("ben");
		expect(late.awareness()).toEqual(expected);
		expect(test.store.calls.filter((call) => call !== "load" && call !== "claim")).toEqual([
			"writeRecord",
		]);
	});

	it("accepts states only for the first client ID, and not one another connection holds", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const ben = await test.join("ben");
		ana.announce([{ clientId: 7, clock: 1, state: { cursor: 1 } }]);
		ana.announce([{ clientId: 8, clock: 1, state: { cursor: 2 } }]);
		ben.announce([{ clientId: 7, clock: 2, state: { cursor: 9 } }]);
		expect(ben.awareness().map((entry) => [entry.clientId, entry.clock])).toEqual([[7, 1]]);
	});

	it("broadcasts a removal with the next clock when a connection closes", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const ben = await test.join("ben");
		ana.announce([{ clientId: 7, clock: 4, state: { cursor: 1 } }]);
		ana.disconnect();
		expect(ben.awareness().at(-1)).toEqual({ clientId: 7, clock: 5, state: null });
		const late = await test.join("cat");
		expect(late.awareness()).toEqual([]);
	});
});
