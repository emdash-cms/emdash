import { readField, snapshotContains } from "@emdash-cms/admin/internal/co-editing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { CLOSE_CODES } from "../../../src/rooms/types.js";
import {
	advance,
	blocksText,
	BODY,
	settle,
	TestClient,
	TestRoom,
	useRoomTimers,
} from "./test-room.js";

beforeEach(useRoomTimers);
afterEach(() => {
	vi.useRealTimers();
});

describe("when to save", () => {
	it("saves 2 s after the latest co-editor update", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.type("Hi ");
		await advance(1900);
		ana.type("there, ");
		await advance(1900);
		expect(test.site.saves).toHaveLength(0);
		await advance(100);
		expect(test.site.saves).toHaveLength(1);
		expect(test.storedText()).toBe("there, Hi First paragraph.");
	});

	it("saves at least every 10 s while updates keep arriving", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		for (let second = 0; second < 10; second++) {
			ana.type(`${second} `);
			await advance(1000);
		}
		expect(test.site.saves).toHaveLength(1);
		expect(test.site.saves[0]?.kept).toBe(false);
	});

	it("saves when the last co-editor leaves", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const viewer = await test.join("vic", { access: "view" });
		ana.type("Bye ");
		ana.disconnect();
		await settle();
		expect(test.site.saves).toHaveLength(1);
		expect(test.storedText()).toBe("Bye First paragraph.");
		expect(viewer.closed).toBeNull();
	});

	it("saves a kept checkpoint as the user who sends save", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const ben = await test.join("ben");
		ana.type("Hi ");
		await settle();
		ben.requestSave();
		await settle();
		expect(test.site.saves).toMatchObject([{ actorId: "ben", kept: true, editedBy: ["ana"] }]);
		expect(test.site.revisions.at(-1)?.kind).toBe("kept");
	});

	it("ignores save from a viewer", async () => {
		const test = new TestRoom();
		await test.join("ana");
		const viewer = await test.join("vic", { access: "view" });
		viewer.requestSave();
		await settle();
		expect(test.site.saves).toHaveLength(0);
	});
});

describe("save steps", () => {
	it("sends only changed fields, as the latest editor, with the merge base's _rev", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const ben = await test.join("ben");
		const rev = test.site.current.rev;
		ana.type("Hi ");
		await settle();
		ben.setField("title", "Ben's title");
		await advance(2000);
		expect(test.site.saves).toEqual([
			{
				actorId: "ben",
				rev,
				data: { title: "Ben's title", body: test.site.current.data.body },
				kept: false,
				editedBy: ["ben", "ana"],
			},
		]);
		expect(test.storedText()).toBe("Hi First paragraph.");
	});

	it("sends typing during a pending save with the next save", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", "First");
		test.site.onSave = () => {
			test.site.onSave = null;
			ana.type("Typed while saving. ");
		};
		await advance(2000);
		expect(test.site.saves[0]?.data).toEqual({ title: "First" });
		await advance(2000);
		expect(test.site.saves).toHaveLength(2);
		expect(test.site.saves[1]?.data).toHaveProperty("body");
		expect(test.storedText()).toBe("Typed while saving. First paragraph.");
	});

	it("stores every update the save holds before it saves", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		let storedAtSave = "";
		test.site.onSave = () => {
			const doc = new Y.Doc();
			for (const update of test.store.updates) Y.applyUpdate(doc, update);
			storedAtSave = blocksText(readField(doc, BODY));
		};
		ana.type("Stored ");
		await advance(500);
		ana.requestSave();
		await settle();
		expect(test.site.saves).toHaveLength(1);
		expect(storedAtSave).toBe("Stored First paragraph.");
	});

	it("records a checkpoint without saving when no value changed", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", "Changed");
		ana.setField("title", "Hello");
		await advance(2000);
		expect(test.site.saves).toHaveLength(0);
		const checkpoint = ana.checkpoints().at(-1);
		expect(checkpoint).toMatchObject({ rev: test.site.current.rev, editedBy: ["ana"] });
		expect(snapshotContains(Y.decodeSnapshot(checkpoint!.snapshot), Y.snapshot(ana.doc))).toBe(
			true,
		);
	});

	it("keeps _rev for a kept checkpoint with nothing changed", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", "Draft");
		await advance(2000);
		const rev = test.site.current.rev;
		expect(test.site.revisions.at(-1)?.kind).toBe("autosave");
		ana.requestSave();
		await settle();
		expect(test.site.saves.at(-1)).toMatchObject({ data: {}, kept: true, rev });
		expect(test.site.saves.at(-1)).not.toHaveProperty("slug");
		expect(test.site.current.rev).toBe(rev);
		expect(test.site.revisions.at(-1)?.kind).toBe("kept");
		expect(ana.checkpoints().at(-1)?.rev).toBe(rev);
	});

	it("keeps an editor who typed during the save for the next one", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const ben = await test.join("ben");
		ana.setField("title", "Ana");
		test.site.onSave = () => {
			test.site.onSave = null;
			ben.type("Ben ");
		};
		await advance(2000);
		expect(test.site.saves[0]?.editedBy).toEqual(["ana"]);
		expect(test.store.record?.editors).toEqual(["ben"]);
		await advance(2000);
		expect(test.site.saves[1]).toMatchObject({ actorId: "ben", editedBy: ["ben"] });
		expect(test.store.record?.editors).toEqual([]);
	});

	it("never writes a hook's output into the document", async () => {
		const test = new TestRoom();
		test.site.hook = (data) => ({ ...data, title: String(data.title).toUpperCase() });
		const ana = await test.join("ana");
		ana.setField("title", "quiet");
		await advance(2000);
		expect(test.site.current.data.title).toBe("QUIET");
		await test.site.write({ data: { body: test.site.current.data.body } }, ["seo"]);
		await settle();
		expect(ana.field("title")).toBe("quiet");
		ana.type("More ");
		await advance(2000);
		expect(test.site.saves.at(-1)?.data).not.toHaveProperty("title");
	});
});

describe("save results", () => {
	it("merges after a conflict and retries with the typed field", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", "Typed");
		test.site.change({ data: { body: [...(test.site.current.data.body as unknown[])] } });
		await advance(2000);
		expect(test.site.saves.map((save) => save.data)).toEqual([
			{ title: "Typed" },
			{ title: "Typed" },
		]);
		expect(test.site.saves[1]?.rev).not.toBe(test.site.saves[0]?.rev);
		expect(test.site.current.data.title).toBe("Typed");
	});

	it("waits for the next update after a second conflict", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		test.site.forced = ["CONFLICT", "CONFLICT"];
		ana.setField("title", "Typed");
		await advance(2000);
		expect(test.site.saves).toHaveLength(2);
		await advance(20_000);
		expect(test.site.saves).toHaveLength(2);
		ana.type("Again ");
		await advance(2000);
		expect(test.site.saves).toHaveLength(3);
		expect(test.site.saves[2]?.data).toHaveProperty("title", "Typed");
	});

	it("saves after the next notification following a second conflict", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		test.site.forced = ["CONFLICT", "CONFLICT"];
		ana.setField("title", "Typed");
		await advance(2000);
		expect(test.site.saves).toHaveLength(2);
		await test.site.write({ data: { body: [] } });
		await advance(2000);
		expect(test.site.saves).toHaveLength(3);
		expect(test.site.current.data.title).toBe("Typed");
	});

	it("saves as the next editor when the site refuses the actor", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const ben = await test.join("ben");
		ana.setField("title", "Ana");
		await settle();
		ben.type("Ben ");
		test.site.forbidden.add("ben");
		await advance(2000);
		expect(test.site.saves.map((save) => save.actorId)).toEqual(["ben", "ana"]);
		expect(ben.closed?.code).toBe(CLOSE_CODES.rejoin);
		expect(ana.closed).toBeNull();
		expect(test.storedText()).toBe("Ben First paragraph.");
	});

	it("forgets the unused tokens of a user the site refuses", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const unused = (await test.room.issueToken(test.claims("ana"))) as { token: string };
		test.site.forbidden.add("ana");
		ana.setField("title", "Ana");
		await advance(2000);
		expect(ana.closed?.code).toBe(CLOSE_CODES.rejoin);
		const again = new TestClient(test, "ana");
		again.connect(unused.token);
		expect(again.closed?.code).toBe(CLOSE_CODES.busy);
	});

	it("waits when no editor can save", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		test.site.forbidden.add("ana");
		ana.setField("title", "Ana");
		await advance(2000);
		expect(test.site.saves.map((save) => save.actorId)).toContain("ana");
		expect(test.site.saves.every((save) => save.actorId === "ana")).toBe(true);
		expect(test.site.current.data.title).toBe("Hello");
		expect(ana.closed?.code).toBe(CLOSE_CODES.rejoin);
		test.site.forbidden.clear();
		const ben = await test.join("ben");
		ben.type("Ben ");
		await advance(2000);
		expect(test.site.saves.at(-1)).toMatchObject({
			actorId: "ben",
			data: { title: "Ana" },
			editedBy: ["ben", "ana"],
		});
	});

	it("starts over with deleted and a recovery revision when the entry is in Trash", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.type("Unsaved ");
		test.site.change({ trashed: true });
		await advance(2000);
		expect(ana.closed?.code).toBe(CLOSE_CODES.deleted);
		expect(test.site.recoveries).toHaveLength(1);
		expect(blocksText(test.site.recoveries[0]?.data.body)).toBe("Unsaved First paragraph.");
		expect(test.site.recoveries[0]).toMatchObject({ slug: "post", editedBy: ["ana"] });
		expect(test.store.record).toBeNull();
	});

	it("starts over with deleted and no recovery revision when the entry is gone", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.type("Unsaved ");
		test.site.remove();
		await advance(2000);
		expect(ana.closed?.code).toBe(CLOSE_CODES.deleted);
		expect(test.site.recoveries).toHaveLength(0);
		expect(test.store.record).toBeNull();
	});

	it("sends a refusal to clients and retries at the next update", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const viewer = await test.join("vic", { access: "view" });
		test.site.forced = ["REFUSED"];
		ana.setField("title", "Too long");
		await advance(2000);
		const refused = { kind: "refused", code: "VALIDATION_ERROR" };
		expect(ana.notices()).toContainEqual(expect.objectContaining(refused));
		expect(viewer.notices()).toContainEqual(expect.objectContaining(refused));
		await advance(20_000);
		expect(test.site.saves).toHaveLength(1);
		ana.type("x");
		await advance(2000);
		expect(test.site.saves).toHaveLength(2);
		expect(test.site.saves[1]?.data).toHaveProperty("title", "Too long");
	});

	it("counts an unreachable site as a refusal", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		test.site.forced = ["reject"];
		ana.setField("title", "Offline");
		await advance(2000);
		expect(ana.notices()).toContainEqual(expect.objectContaining({ kind: "refused" }));
		expect(ana.closed).toBeNull();
		ana.type("x");
		await advance(2000);
		expect(test.site.current.data.title).toBe("Offline");
	});

	it("saves the fields it can read when another can't be, and shows nothing as saved", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const ben = await test.join("ben");
		const checkpoints = ben.checkpoints().length;
		ana.setField("title", new Uint8Array([1, 2]));
		ben.type("Ben ");
		await advance(2000);
		expect(test.storedText()).toBe("Ben First paragraph.");
		expect(test.site.current.data.title).toBe("Hello");
		expect(ben.checkpoints()).toHaveLength(checkpoints);
		expect(ben.notices()).toContainEqual(
			expect.objectContaining({ kind: "refused", code: "INVALID_CONTENT" }),
		);
		ana.setField("title", "Fixed");
		await advance(2000);
		expect(test.site.saves.at(-1)?.data).toEqual({ title: "Fixed" });
		expect(ben.checkpoints()).toHaveLength(checkpoints + 1);
	});

	it("refuses a save holding a value that isn't JSON, and retries at the next update", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", new Uint8Array([1, 2]));
		await advance(2000);
		expect(test.site.saves).toHaveLength(0);
		expect(ana.notices()).toContainEqual(
			expect.objectContaining({ kind: "refused", code: "INVALID_CONTENT" }),
		);
		ana.setField("title", "Fixed");
		await advance(2000);
		expect(test.site.saves).toMatchObject([{ data: { title: "Fixed" } }]);
	});
});
