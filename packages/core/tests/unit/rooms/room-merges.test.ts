import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLOSE_CODES, RoomSaveError } from "../../../src/rooms/types.js";
import {
	advance,
	blocksText,
	paragraph,
	settle,
	TestClient,
	TestRoom,
	useRoomTimers,
} from "./test-room.js";

beforeEach(useRoomTimers);
afterEach(() => {
	vi.useRealTimers();
});

/** Blocks without keys, which the converter derives, so they don't round-trip byte for byte. */
function keyless(text: string) {
	return [{ _type: "block", style: "normal", children: [{ _type: "span", text }] }];
}

function updatesReceived(client: TestClient): number {
	return client.received.filter((message) => message.type === "sync-update").length;
}

describe("notifications and merges", () => {
	it("ignores a notification while the room isn't open", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.disconnect();
		await advance(10_000);
		const loads = test.site.loads;
		await test.site.write({ data: { title: "Outside" } });
		await settle();
		expect(test.site.loads).toBe(loads);
	});

	it("names the outside values, writes the stored value and sends the new _rev", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const viewer = await test.join("vic", { access: "view" });
		await test.site.write({ data: { title: "Outside" } }, ["seo"]);
		await settle();
		for (const client of [ana, viewer]) {
			expect(client.field("title")).toBe("Outside");
			expect(client.notices()).toEqual([
				{ kind: "values", values: ["seo"] },
				{ kind: "outside", fields: ["title"] },
			]);
			expect(client.checkpoints().at(-1)).toMatchObject({
				rev: test.site.current.rev,
				editedBy: [],
			});
		}
		expect(test.site.saves).toHaveLength(0);
	});

	it("still sends a field typed before a merge that leaves it unchanged", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", "Typed");
		await settle();
		await test.site.write({ data: { body: [paragraph("b", "Outside body.")] } });
		await settle();
		expect(ana.text()).toBe("Outside body.");
		await advance(2000);
		expect(test.site.saves).toMatchObject([{ data: { title: "Typed" } }]);
		expect(test.site.current.data.title).toBe("Typed");
		expect(test.storedText()).toBe("Outside body.");
	});

	it("keeps the document's value when both sides changed, and sends it next", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", "Document");
		await settle();
		await test.site.write({ data: { title: "Stored" } });
		await settle();
		expect(ana.field("title")).toBe("Document");
		await advance(2000);
		expect(test.site.current.data.title).toBe("Document");
	});

	it("writes two outside writes to a touched field between saves, and never saves it back", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", "Draft");
		ana.setField("title", "Hello");
		await settle();
		await test.site.write({ data: { title: "First" } });
		await settle();
		await test.site.write({ data: { title: "Second" } });
		await settle();
		expect(ana.field("title")).toBe("Second");
		await advance(2000);
		expect(test.site.current.data.title).toBe("Second");
	});

	it("takes a written field's hash from the document, so a later save doesn't send it", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		await test.site.write({ data: { body: keyless("Outside.") } });
		await settle();
		expect(ana.text()).toBe("Outside.");
		ana.setField("title", "Typed");
		await advance(1000);
		test.restart();
		await test.join("ben");
		await advance(2000);
		expect(test.site.saves).toHaveLength(1);
		expect(test.site.saves[0]?.data).toEqual({ title: "Typed" });
		expect(test.site.current.data.body).toEqual(keyless("Outside."));
	});

	it("sends a field it kept at the next save, even once it's back to the old value", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", "Mine");
		await settle();
		await test.site.write({ data: { title: "Theirs" } });
		await settle();
		ana.setField("title", "Hello");
		await advance(2000);
		expect(test.site.current.data.title).toBe("Hello");
	});

	it("merges a notification as an open room even if the room closed while it waited", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", "Document");
		await settle();
		let openGate = () => {};
		test.site.loadGate = new Promise((resolve) => {
			openGate = resolve;
		});
		await test.site.write({ data: { title: "Stored" } });
		ana.disconnect();
		await advance(11_000);
		test.site.loadGate = null;
		openGate();
		await settle();
		await advance(2000);
		expect(test.site.recoveries).toHaveLength(0);
		expect(test.site.current.data.title).toBe("Document");
	});

	it("never writes stored rich text with marks the editor can't represent", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const blink = [
			{
				_type: "block",
				_key: "z",
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", _key: "zs", text: "Blinking.", marks: ["blink"] }],
			},
		];
		await test.site.write({ data: { body: blink } });
		await settle();
		expect(ana.text()).toBe("First paragraph.");
		await test.site.write({ data: { title: "Later" } });
		await settle();
		expect(ana.notices()).toContainEqual({ kind: "outside", fields: ["title"] });
		expect(ana.text()).toBe("First paragraph.");
	});

	it("relays a merge only after its record is stored", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const before = updatesReceived(ana);
		test.store.failNext("writeRecord");
		await test.site.write({ data: { title: "Outside" } });
		await settle();
		expect(ana.closed?.code).toBe(CLOSE_CODES.reset);
		expect(updatesReceived(ana)).toBe(before);
		expect(ana.field("title")).toBe("Hello");
	});

	it("stores a merge's update with every record that holds its merge base", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const ben = await test.join("ben");
		const touch = test.store.holdNext("touch");
		ben.disconnect();
		ana.type("Typed ");
		await advance(1000);
		await test.site.write({ data: { title: "Outside" } });
		await settle();
		test.store.failNext("writeRecord", 2);
		touch.open();
		await settle();
		expect(ana.closed?.code).toBe(CLOSE_CODES.reset);
		const cat = await test.join("cat");
		await advance(2000);
		expect(cat.field("title")).toBe("Outside");
		expect(test.site.current.data.title).toBe("Outside");
		expect(test.storedText()).toBe("Typed First paragraph.");
	});

	it("closes every connection with rejoin when the status changes", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const draftClaims = test.claims("ben");
		const unused = await test.room.issueToken(test.claims("cat"));
		await test.site.write({ status: "published" });
		await settle();
		expect(ana.closed?.code).toBe(CLOSE_CODES.rejoin);
		expect(await test.room.issueToken(draftClaims)).toBe("stale");
		const late = new TestClient(test, "cat");
		late.connect((unused as { token: string }).token);
		expect(late.closed?.code).toBe(CLOSE_CODES.busy);
	});

	it("starts over with deleted, saving uncovered updates, when a merge finds the entry in Trash", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.type("Unsaved ");
		await settle();
		await test.site.write({ trashed: true });
		await settle();
		expect(ana.closed?.code).toBe(CLOSE_CODES.deleted);
		expect(blocksText(test.site.recoveries[0]?.data.body)).toBe("Unsaved First paragraph.");
		expect(test.store.record).toBeNull();
	});

	it("keeps updates typed just before a drop whose recovery save fails, for the next try", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", "Typed");
		await settle();
		test.site.rejectRecoveries = true;
		await test.site.write({ trashed: true });
		await settle();
		expect(ana.closed?.code).toBe(CLOSE_CODES.deleted);
		test.site.rejectRecoveries = false;
		await advance(60 * 60 * 1000);
		await test.room.expire();
		expect(test.site.recoveries).toMatchObject([{ data: { title: "Typed" } }]);
	});

	it("starts over with rejoin when a merge loads another schema hash", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		await test.site.write({ hash: "schema-2", data: { title: "New schema" } });
		await settle();
		expect(ana.closed?.code).toBe(CLOSE_CODES.rejoin);
		expect(ana.field("title")).toBe("Hello");
		expect(test.store.record).toBeNull();
		expect(test.site.recoveries).toHaveLength(0);
	});
});

describe("operations", () => {
	it("saves a kept checkpoint as the actor and holds other saves until the release", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", "Before");
		await settle();
		const held = await test.room.save("ana");
		expect(held).toMatchObject({ rev: test.site.current.rev, hold: expect.any(String) });
		expect(test.site.saves).toMatchObject([
			{ actorId: "ana", kept: true, data: { title: "Before" } },
		]);
		expect(ana.notices()).toContainEqual({ kind: "operation", by: "ana" });
		ana.setField("title", "During");
		await advance(10_000);
		expect(test.site.saves).toHaveLength(1);
		await test.room.release((held as { hold: string }).hold);
		await advance(0);
		expect(test.site.saves).toHaveLength(2);
		expect(test.site.current.data.title).toBe("During");
	});

	it("answers conflict, saving nothing, for another _rev or uncovered updates", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		expect(await test.room.save("ana", "rev-old")).toBe("conflict");
		ana.setField("title", "Uncovered");
		await settle();
		expect(await test.room.save("ana", test.site.current.rev)).toBe("conflict");
		expect(test.site.saves).toHaveLength(0);
	});

	it("answers conflict for a _rev an unmerged write replaced, without saving again or holding", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const rev = test.site.current.rev;
		test.site.change({ data: { title: "Outside" } });
		expect(await test.room.save("ana", rev)).toBe("conflict");
		expect(test.site.saves).toHaveLength(1);
		expect(ana.field("title")).toBe("Outside");
		ana.setField("title", "Typed");
		await advance(2000);
		expect(test.site.current.data.title).toBe("Typed");
	});

	it("merges first for a _rev an unmerged write produced, then saves", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		test.site.change({ data: { title: "Outside" } });
		expect(await test.room.save("ana", test.site.current.rev)).toMatchObject({
			hold: expect.any(String),
		});
		expect(ana.field("title")).toBe("Outside");
	});

	it("answers null when the room isn't open", async () => {
		const test = new TestRoom();
		expect(await test.room.save("ana")).toBeNull();
	});

	it("rejects with the save's error and never saves as another user", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", "Ana");
		await settle();
		test.site.forbidden.add("ben");
		await expect(test.room.save("ben")).rejects.toThrow(RoomSaveError);
		expect(test.site.saves.map((save) => save.actorId)).toEqual(["ben"]);
		test.site.forced = ["CONFLICT"];
		test.site.forbidden.clear();
		const held = await test.room.save("ben");
		expect(test.site.saves.map((save) => save.actorId)).toEqual(["ben", "ben", "ben"]);
		expect(held).toMatchObject({ rev: test.site.current.rev });
	});

	it("overwrites with a restore and a later save doesn't undo it", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const restored = [paragraph("r", "Restored.")];
		const held = (await test.room.save("ana")) as { hold: string };
		ana.type("Typed during the restore. ");
		await settle();
		test.site.change({ data: { body: restored } });
		await advance(3000);
		expect(test.site.saves).toHaveLength(1);
		await test.room.release(held.hold, { overwrite: true });
		await advance(2000);
		expect(ana.text()).toBe("Restored.");
		expect(test.storedText()).toBe("Restored.");
		ana.type("After. ");
		await advance(2000);
		expect(test.storedText()).toBe("After. Restored.");
	});

	it("writes an outside write that follows a restore", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const held = (await test.room.save("ana")) as { hold: string };
		ana.type("Typed during the restore. ");
		await settle();
		test.site.change({ data: { body: [paragraph("r", "Restored.")] } });
		await test.room.release(held.hold, { overwrite: true });
		await settle();
		await test.site.write({
			data: { body: [paragraph("r", "Restored."), paragraph("o", "Outside.")] },
		});
		await settle();
		expect(ana.text()).toBe("Restored.\nOutside.");
		await advance(2000);
		expect(test.storedText()).toBe("Restored.\nOutside.");
	});

	it("merges a release for an unknown hold as a plain notification", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", "Document");
		await settle();
		test.site.change({ data: { title: "Stored", body: [paragraph("x", "Stored body.")] } });
		await test.room.release("no-such-hold", { overwrite: true });
		expect(ana.field("title")).toBe("Document");
		expect(ana.text()).toBe("Stored body.");
	});

	it("ends a hold after 30 s, then merges", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const held = (await test.room.save("ana")) as { hold: string };
		test.site.change({ data: { title: "Published" } });
		await advance(29_000);
		expect(ana.field("title")).toBe("Hello");
		await advance(1000);
		expect(ana.field("title")).toBe("Published");
		await test.room.release(held.hold, { overwrite: true });
		expect(ana.field("title")).toBe("Published");
	});

	it("takes turns, and a token request that needs a merge waits for the hold", async () => {
		const test = new TestRoom();
		await test.join("ana");
		const first = (await test.room.save("ana")) as { hold: string };
		let second: unknown = null;
		void test.room.save("ben").then((result) => (second = result));
		test.site.change({ data: { title: "Outside" } });
		let token: unknown = null;
		void test.room.issueToken(test.claims("cat")).then((result) => (token = result));
		await advance(5000);
		expect(second).toBeNull();
		expect(token).toBeNull();
		await test.room.release(first.hold);
		await settle();
		expect(second).toMatchObject({ hold: expect.any(String) });
		expect(token).toBeNull();
		await test.room.release((second as { hold: string }).hold);
		await settle();
		expect(token).toMatchObject({ token: expect.any(String) });
	});
});
