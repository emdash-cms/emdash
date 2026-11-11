import { readField, encodeSyncStep1 } from "@emdash-cms/admin/internal/co-editing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { CLOSE_CODES, parseRoomId, roomId } from "../../../src/rooms/types.js";
import { advance, BODY, settle, TestRoom, TITLE, useRoomTimers } from "./test-room.js";

beforeEach(useRoomTimers);
afterEach(() => {
	vi.useRealTimers();
});

const NOTES = { slug: "notes", type: "text" } as const;

function storedDoc(test: TestRoom): Y.Doc {
	const doc = new Y.Doc();
	for (const update of test.store.updates) Y.applyUpdate(doc, update);
	return doc;
}

describe("store", () => {
	it("stores updates within 1 s, with the record when the editors change", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		test.store.calls = [];
		ana.type("A ");
		await advance(999);
		expect(test.store.calls).toEqual([]);
		await advance(1);
		expect(test.store.calls).toEqual(["writeRecord"]);
		expect(test.store.record?.editors).toEqual(["ana"]);
		ana.type("B ");
		await advance(1000);
		expect(test.store.calls).toEqual(["writeRecord", "append"]);
		expect(readField(storedDoc(test), BODY)).toEqual(readField(ana.doc, BODY));
	});

	it("keeps the editors' names across a restart", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.type("Before the restart ");
		await advance(1000);
		expect(test.site.saves).toHaveLength(0);
		test.restart();
		await test.join("ben");
		await settle();
		expect(test.site.saves).toMatchObject([{ actorId: "ana", editedBy: ["ana"] }]);
		expect(test.storedText()).toBe("Before the restart First paragraph.");
	});

	it("gets lost updates from a reconnecting client, credited to its user", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.type("Stored ");
		await advance(1000);
		ana.type("Lost ");
		test.restart();
		await test.rejoin(ana);
		await advance(2000);
		expect(test.storedText()).toBe("Lost Stored First paragraph.");
		expect(test.site.saves.at(-1)).toMatchObject({ actorId: "ana", editedBy: ["ana"] });
	});

	it("keeps an unrecorded save's fields without duplicating them", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.type("Saved ");
		await advance(1000);
		test.store.failNext("writeRecord");
		await advance(1000);
		expect(test.storedText()).toBe("Saved First paragraph.");
		expect(ana.closed?.code).toBe(CLOSE_CODES.reset);
		test.restart();
		const ben = await test.join("ben");
		expect(ben.text()).toBe("Saved First paragraph.");
		ben.type("Then ");
		await advance(2000);
		expect(test.storedText()).toBe("Then Saved First paragraph.");
		expect(test.site.recoveries).toHaveLength(0);
	});

	it("compacts past 1 MB of stored updates", async () => {
		const test = new TestRoom({ fields: [TITLE, BODY, NOTES] });
		const ana = await test.join("ana");
		for (const letter of ["a", "b", "c", "d"]) {
			ana.setField(NOTES.slug, letter.repeat(300_000));
			await advance(1000);
		}
		expect(test.store.compactions).toBe(1);
		expect(test.store.updates).toHaveLength(1);
		expect(test.store.storedBytes()).toBeLessThan(400_000);
		test.restart();
		const ben = await test.join("ben");
		expect(ben.field(NOTES.slug)).toBe("d".repeat(300_000));
	});

	it("counts only updates stored since the last compaction after a restart", async () => {
		const fields = ["a", "b", "c", "d"].map((slug) => ({ slug, type: "text" as const }));
		const test = new TestRoom({ fields: [TITLE, BODY, ...fields] });
		const ana = await test.join("ana");
		for (const field of fields) {
			ana.setField(field.slug, field.slug.repeat(300_000));
			await advance(1000);
		}
		expect(test.store.compactions).toBe(1);
		test.restart();
		const ben = await test.join("ben");
		ben.setField("title", "After");
		await advance(1000);
		expect(test.store.compactions).toBe(1);
	});

	it("saves and drops a compacted state over 2 MB", async () => {
		const fields = ["a", "b", "c"].map((slug) => ({ slug, type: "text" as const }));
		const test = new TestRoom({ fields: [TITLE, BODY, ...fields] });
		const ana = await test.join("ana");
		for (const [index, slug] of ["a", "b", "c", "a"].entries()) {
			ana.setField(slug, String(index).repeat(800_000));
			await advance(1000);
		}
		expect(ana.closed?.code).toBe(CLOSE_CODES.rejoin);
		expect(test.store.record).toBeNull();
		expect(test.site.current.data).toMatchObject({
			a: "3".repeat(800_000),
			b: "1".repeat(800_000),
			c: "2".repeat(800_000),
		});
	});

	it("closes every connection with reset and unloads when storing fails", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const viewer = await test.join("vic", { access: "view" });
		ana.type("A ");
		await advance(1000);
		test.store.failNext("append");
		ana.type("B ");
		await advance(1000);
		expect(ana.closed?.code).toBe(CLOSE_CODES.reset);
		expect(viewer.closed?.code).toBe(CLOSE_CODES.reset);
		const ben = await test.join("ben");
		expect(ben.text()).toBe("A First paragraph.");
	});

	it("closes with rejoin and forgets the document without saving when the claim is lost", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.type("A ");
		test.store.claimLost = true;
		await advance(1000);
		expect(ana.closed?.code).toBe(CLOSE_CODES.rejoin);
		await advance(30_000);
		expect(test.site.saves).toHaveLength(0);
		expect(test.store.calls).not.toContain("release");
	});

	it("autosaves state it loads while an unloaded state's autosave waits in the queue", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.type("Unsaved ");
		await advance(1000);
		let openLoads!: () => void;
		test.site.loadGate = new Promise((resolve) => {
			openLoads = resolve;
		});
		await test.site.write({ data: { title: "Outside" } });
		const token = test.room.issueToken(test.claims("ben"));
		test.store.failNext("touch");
		ana.disconnect();
		await settle();
		expect(test.site.saves).toHaveLength(0);
		test.site.loadGate = null;
		openLoads();
		expect(await token).toMatchObject({ token: expect.any(String) });
		await settle();
		expect(test.site.saves).toHaveLength(1);
		expect(test.storedText()).toBe("Unsaved First paragraph.");
		expect(test.site.current.data.title).toBe("Outside");
	});

	it("refuses a token when the room can't store", async () => {
		const test = new TestRoom();
		test.store.failNext("writeRecord");
		expect(await test.room.issueToken(test.claims("ana"))).toBeNull();
		expect(await test.room.issueToken(test.claims("ana"))).toMatchObject({
			token: expect.any(String),
		});
	});

	it("answers busy when another process holds the claim", async () => {
		const test = new TestRoom();
		test.store.refuseClaims = true;
		expect(await test.room.issueToken(test.claims("ana"))).toBe("busy");
	});
});

describe("claim renewal", () => {
	it("renews a held claim only when no store call or claim renewed it in the last 10 s", async () => {
		const test = new TestRoom();
		await test.room.renew();
		expect(test.store.calls).toEqual([]);

		const ana = await test.join("ana");
		expect(test.room.holdsClaim).toBe(true);
		test.store.calls = [];
		await advance(9_999);
		await test.room.renew();
		expect(test.store.calls).toEqual([]);
		await advance(1);
		await test.room.renew();
		await test.room.renew();
		expect(test.store.calls).toEqual(["renew"]);

		await advance(5_000);
		ana.disconnect();
		await settle();
		expect(test.store.calls).toEqual(["renew", "touch"]);
		await advance(9_999);
		await test.room.renew();
		expect(test.store.calls).toEqual(["renew", "touch"]);
		await advance(1);
		expect(test.room.holdsClaim).toBe(false);
		await test.room.renew();
		expect(test.store.calls).toEqual(["renew", "touch", "release"]);
	});

	it("closes every connection with rejoin and forgets the document when renewing finds the claim lost", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const vic = await test.join("vic", { access: "view" });
		test.store.claimLost = true;
		await advance(10_000);

		await test.room.renew();

		expect(ana.closed?.code).toBe(CLOSE_CODES.rejoin);
		expect(vic.closed?.code).toBe(CLOSE_CODES.rejoin);
		expect(test.room.holdsClaim).toBe(false);
		test.store.claimLost = false;
		test.store.claimed = false;
		test.store.calls = [];
		await test.join("ben");
		expect(test.store.calls.slice(0, 2)).toEqual(["claim", "load"]);
		expect(test.store.calls).not.toContain("release");
		expect(test.site.saves).toHaveLength(0);
	});

	it("stops holding a lost claim, and closes resumed sockets with rejoin, while nothing is loaded", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		test.restart();
		test.room.resume(ana, {
			userId: "ana",
			name: "Name ana",
			access: "edit",
			connectedAt: Date.now(),
			clientId: null,
		});
		const load = test.store.holdNext("load");
		ana.toRoom(encodeSyncStep1(ana.doc));
		await settle();
		expect(test.room.holdsClaim).toBe(true);
		test.store.claimLost = true;
		await advance(10_000);

		await test.room.renew();

		expect(ana.closed?.code).toBe(CLOSE_CODES.rejoin);
		expect(test.room.holdsClaim).toBe(false);
		load.open();
		await settle();
		expect(test.store.calls).not.toContain("release");
	});
});

describe("room IDs", () => {
	it("parses the entry back out of a room ID, and refuses one that names no entry", () => {
		expect(parseRoomId(roomId({ collection: "posts", id: "01ENTRY" }))).toEqual({
			collection: "posts",
			id: "01ENTRY",
		});
		expect(parseRoomId(roomId({ collection: "posts", id: "a:b" }))).toEqual({
			collection: "posts",
			id: "a:b",
		});
		for (const id of ["posts", ":01ENTRY", "posts:", ""]) expect(parseRoomId(id)).toBeNull();
	});
});
