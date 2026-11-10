import { encodeSyncStep1 } from "@emdash-cms/admin/internal/co-editing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
	MAX_RECOVERY_BYTES,
	MAX_ROOM_CONNECTIONS,
	MAX_USER_CONNECTIONS,
} from "../../../src/rooms/limits.js";
import { CLOSE_CODES, isRoomToken } from "../../../src/rooms/types.js";
import {
	advance,
	blocksText,
	FINGERPRINT,
	settle,
	TestClient,
	TestRoom,
	useRoomTimers,
} from "./test-room.js";

beforeEach(useRoomTimers);
afterEach(() => {
	vi.useRealTimers();
});

const HOUR = 60 * 60 * 1000;

function resumedInfo(userId: string) {
	return {
		userId,
		name: `Name ${userId}`,
		access: "edit" as const,
		connectedAt: Date.now(),
		clientId: null,
	};
}

/** Leaves the room with updates no save covered, then lets it close. */
async function leaveUncovered(test: TestRoom, title: string): Promise<void> {
	const ana = await test.join("ana");
	test.site.forced = ["REFUSED", "REFUSED"];
	ana.setField("title", title);
	await advance(2000);
	ana.disconnect();
	await advance(10_000);
	expect(test.store.record).not.toBeNull();
	expect(test.room.isOpen()).toBe(false);
}

describe("initializing", () => {
	it("stores the record before answering, and welcomes with its lineage and checkpoint", async () => {
		const test = new TestRoom();
		const result = await test.room.issueToken(test.claims("ana"));
		expect(result).toMatchObject({ token: expect.any(String) });
		const record = test.store.record;
		expect(record).toMatchObject({
			fingerprint: FINGERPRINT,
			editors: [],
			status: "draft",
			authorId: "author",
			mergeBase: { rev: test.site.current.rev },
		});
		expect(test.site.loads).toBe(1);
		const ana = await test.join("ana");
		const welcome = ana.received[0];
		expect(welcome).toMatchObject({ type: "welcome", lineage: record?.lineage, access: "edit" });
		expect(ana.text()).toBe("First paragraph.");
		expect(ana.field("title")).toBe("Hello");
		expect(ana.field("slug")).toBe("post");
	});

	it.each([
		["the entry is in Trash", (test: TestRoom) => test.site.change({ trashed: true })],
		["the entry is gone", (test: TestRoom) => test.site.remove()],
		[
			"the entry is over 1 MB",
			(test: TestRoom) => test.site.change({ data: { title: "x".repeat(1_100_000) } }),
		],
		[
			"the entry's schema hash isn't the token's",
			(test: TestRoom) => test.site.change({ hash: "schema-2" }),
		],
		[
			"rich text has marks the editor can't represent",
			(test: TestRoom) =>
				test.site.change({
					data: {
						body: [
							{
								_type: "block",
								_key: "z",
								style: "normal",
								markDefs: [],
								children: [{ _type: "span", _key: "zs", text: "x", marks: ["blink"] }],
							},
						],
					},
				}),
		],
		["rich text isn't blocks", (test: TestRoom) => test.site.change({ data: { body: "text" } })],
		["a value isn't JSON", (test: TestRoom) => test.site.change({ data: { title: Number.NaN } })],
	])("refuses with null when %s", async (_case, arrange) => {
		const test = new TestRoom();
		const claims = test.claims("ana");
		arrange(test);
		expect(await test.room.issueToken(claims)).toBeNull();
		expect(test.store.record).toBeNull();
	});

	it("refuses with null, without starting over, a token from another build", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const lineage = test.store.record?.lineage;
		const other = { ...FINGERPRINT, version: "2.0.0", hash: "schema-2" };
		expect(await test.room.issueToken(test.claims("ben", { fingerprint: other }))).toBeNull();
		expect(ana.closed).toBeNull();
		expect(test.store.record?.lineage).toBe(lineage);
	});
});

describe("lineage, stale rooms and fingerprints", () => {
	it("keeps its lineage across a restart", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const lineage = ana.lineage;
		ana.type("Stored ");
		await advance(1000);
		test.restart();
		await test.rejoin(ana);
		expect(ana.received.findLast((message) => message.type === "welcome")).toMatchObject({
			lineage,
		});
		expect(ana.text()).toBe("Stored First paragraph.");
	});

	it("starts over when a token from its own build has another fingerprint", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.type("Uncovered ");
		await advance(1000);
		const lineage = test.store.record?.lineage;
		test.site.change({ hash: "schema-2" });
		const ben = await test.join("ben", { fingerprint: { ...FINGERPRINT, hash: "schema-2" } });
		expect(ana.closed?.code).toBe(CLOSE_CODES.rejoin);
		expect(ben.lineage).not.toBe(lineage);
		expect(test.store.record?.fingerprint.hash).toBe("schema-2");
		expect(test.site.recoveries).toMatchObject([{ editedBy: ["ana"] }]);
		expect(ben.text()).toBe("First paragraph.");
	});

	it("saves fields from before a schema change in a stale room's recovery revision", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", "Typed");
		ana.type("Typed ");
		await advance(1000);
		test.restart();
		const entry = test.site.current;
		entry.hash = "schema-2";
		entry.fields = [{ slug: "body", type: "text" }];
		entry.data = { body: "Plain" };
		await test.join("ben", { fingerprint: { ...FINGERPRINT, hash: "schema-2" } });
		expect(test.site.recoveries).toMatchObject([{ data: { title: "Typed" }, editedBy: ["ana"] }]);
		expect(blocksText(test.site.recoveries[0]?.data.body)).toBe("Typed First paragraph.");
	});

	it("starts over when it loads a document another build made", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.type("Old build ");
		await advance(1000);
		const lineage = test.store.record?.lineage;
		const build = { version: "1.1.0", commit: "def456" };
		test.restart(build);
		const result = await test.room.issueToken(
			test.claims("ben", { fingerprint: { ...build, hash: "schema-1" } }),
		);
		expect(result).toMatchObject({ token: expect.any(String) });
		expect(test.store.record?.lineage).not.toBe(lineage);
		expect(test.store.record?.fingerprint.version).toBe("1.1.0");
		expect(test.site.recoveries).toHaveLength(1);
	});

	it("saves what it can read of stored state as a recovery revision, and initializes again", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", "Stored");
		await advance(1000);
		test.restart();
		test.store.updates.push(new Uint8Array([255, 255, 255]));
		const ben = await test.join("ben");
		expect(test.site.recoveries).toMatchObject([{ data: { title: "Stored" } }]);
		expect(ben.field("title")).toBe("Hello");
		expect(test.store.updates).toHaveLength(1);
	});

	it("keeps stored state it can't read while its recovery save fails", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", "Stored");
		await advance(1000);
		test.restart();
		test.store.updates.push(new Uint8Array([255, 255, 255]));
		const stored = [...test.store.updates];
		test.site.rejectRecoveries = true;
		expect(await test.room.issueToken(test.claims("ben"))).toBeNull();
		expect(test.store.updates).toEqual(stored);
		test.site.rejectRecoveries = false;
		await test.join("ben");
		expect(test.site.recoveries).toMatchObject([{ data: { title: "Stored" } }]);
	});

	it("saves the document as a recovery revision when the stored checkpoint can't be read", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", "Stored");
		await advance(1000);
		test.restart();
		test.store.record = { ...test.store.record!, checkpoint: "!" };
		const ben = await test.join("ben");
		expect(test.site.recoveries).toMatchObject([{ data: { title: "Stored" } }]);
		expect(ben.field("title")).toBe("Hello");
	});

	it("answers stale when the status changed since the route checked access", async () => {
		const test = new TestRoom();
		await test.join("ana");
		test.site.change({ data: { title: "Unmerged" } });
		const claims = test.claims("ben");
		test.site.change({ status: "published" });
		expect(await test.room.issueToken(claims)).toBe("stale");
	});

	it("starts over and initializes again when a closed room finds a field changed on both sides", async () => {
		const test = new TestRoom();
		await leaveUncovered(test, "Document");
		const lineage = test.store.record?.lineage;
		test.site.change({ data: { title: "Stored" } });
		const ben = await test.join("ben");
		expect(ben.field("title")).toBe("Stored");
		expect(ben.lineage).not.toBe(lineage);
		expect(test.site.recoveries).toMatchObject([
			{ data: { title: "Document" }, editedBy: ["ana"] },
		]);
	});

	it("keeps a closed room's document when both sides changed to the same value", async () => {
		const test = new TestRoom();
		await leaveUncovered(test, "Same");
		const lineage = test.store.record?.lineage;
		test.site.change({ data: { title: "Same" } });
		const ben = await test.join("ben");
		expect(ben.lineage).toBe(lineage);
		expect(test.site.recoveries).toHaveLength(0);
	});
});

describe("tokens and connecting", () => {
	it("answers full at 5 connections for a user and 25 for the room", async () => {
		const test = new TestRoom();
		for (let index = 0; index < MAX_USER_CONNECTIONS; index++) {
			expect(await test.room.issueToken(test.claims("ana"))).toHaveProperty("token");
		}
		expect(await test.room.issueToken(test.claims("ana"))).toBe("full");
		for (let index = MAX_USER_CONNECTIONS; index < MAX_ROOM_CONNECTIONS; index++) {
			await test.join(`user-${index}`);
		}
		expect(await test.room.issueToken(test.claims("zed"))).toBe("full");
	});

	it("closes a socket with busy unless its token is valid, unused and unexpired", async () => {
		const test = new TestRoom();
		await test.join("ana");
		const result = (await test.room.issueToken(test.claims("ben"))) as { token: string };
		const forged = new TestClient(test, "eve");
		expect(forged.connect("not-a-token")).toBeNull();
		expect(forged.closed?.code).toBe(CLOSE_CODES.busy);
		const ben = new TestClient(test, "ben");
		const info = ben.connect(result.token);
		expect(ben.closed).toBeNull();
		expect(info).toMatchObject({ userId: "ben", access: "edit", clientId: null });
		ben.announce([{ clientId: 9, clock: 1, state: {} }]);
		expect(info?.clientId).toBe(9);
		const replay = new TestClient(test, "ben");
		expect(replay.connect(result.token)).toBeNull();
		expect(replay.closed?.code).toBe(CLOSE_CODES.busy);
		const late = (await test.room.issueToken(test.claims("cat"))) as { token: string };
		await advance(60_000);
		const cat = new TestClient(test, "cat");
		cat.connect(late.token);
		expect(cat.closed?.code).toBe(CLOSE_CODES.busy);
	});

	it("issues tokens in the shape a host checks before it asks the room", async () => {
		const test = new TestRoom();
		const result = (await test.room.issueToken(test.claims("ana"))) as { token: string };
		expect(isRoomToken(result.token)).toBe(true);
		expect(isRoomToken(`${result.token}A`)).toBe(false);
	});

	it("sends sync step 1 to co-editors only", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const viewer = await test.join("vic", { access: "view" });
		expect(ana.received.map((message) => message.type).slice(0, 2)).toEqual([
			"welcome",
			"sync-step-1",
		]);
		expect(viewer.received[0]).toMatchObject({ type: "welcome", access: "view" });
		expect(viewer.received.map((message) => message.type)).not.toContain("sync-step-1");
		expect(viewer.text()).toBe("First paragraph.");
	});

	it("forgets a user's unused tokens", async () => {
		const test = new TestRoom();
		await test.join("ana");
		const result = (await test.room.issueToken(test.claims("ben"))) as { token: string };
		await test.room.forgetTokens("ben");
		const ben = new TestClient(test, "ben");
		ben.connect(result.token);
		expect(ben.closed?.code).toBe(CLOSE_CODES.busy);
	});

	it("closes connections older than 15 minutes with rejoin at the next message", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		await advance(10 * 60 * 1000);
		const ben = await test.join("ben");
		await advance(5 * 60 * 1000);
		expect(ana.closed).toBeNull();
		ben.type("Hi ");
		await settle();
		expect(ana.closed?.code).toBe(CLOSE_CODES.rejoin);
		expect(ben.closed).toBeNull();
	});

	it("closes connections older than 15 minutes with rejoin at the hourly drop, without a message", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		await advance(10 * 60 * 1000);
		const ben = await test.join("ben");
		await advance(5 * 60 * 1000);
		await test.room.expire();
		expect(ana.closed?.code).toBe(CLOSE_CODES.rejoin);
		expect(ben.closed).toBeNull();
	});
});

describe("open and release", () => {
	it("stays open for 10 s after the last connection, then releases its claim", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		test.store.calls = [];
		ana.disconnect();
		await settle();
		expect(test.store.calls).toContain("touch");
		await advance(9_000);
		expect(test.room.isOpen()).toBe(true);
		expect(test.store.claimed).toBe(true);
		await advance(1000);
		expect(test.room.isOpen()).toBe(false);
		expect(test.store.claimed).toBe(false);
	});

	it("stays open while a token is unused, for 60 s", async () => {
		const test = new TestRoom();
		await test.room.issueToken(test.claims("ana"));
		await advance(59_000);
		expect(test.room.isOpen()).toBe(true);
		await advance(1000);
		expect(test.room.isOpen()).toBe(false);
		expect(test.store.claimed).toBe(false);
	});

	it("releases its claim after a token request that didn't open it", async () => {
		const test = new TestRoom();
		test.site.change({ trashed: true });
		expect(await test.room.issueToken(test.claims("ana"))).toBeNull();
		await settle();
		expect(test.store.claimed).toBe(false);
	});
});

describe("hourly drop", () => {
	it("saves uncovered updates as a recovery revision, never into the draft, and drops", async () => {
		const test = new TestRoom();
		await leaveUncovered(test, "Unsaved");
		const saves = test.site.saves.length;
		await advance(HOUR);
		await test.room.expire();
		expect(test.site.recoveries).toMatchObject([{ data: { title: "Unsaved" }, editedBy: ["ana"] }]);
		expect(test.site.saves).toHaveLength(saves);
		expect(test.site.current.data.title).toBe("Hello");
		expect(test.store.record).toBeNull();
		expect(test.store.claimed).toBe(false);
	});

	it("keeps state within its hour", async () => {
		const test = new TestRoom();
		await leaveUncovered(test, "Unsaved");
		await advance(HOUR - 20_000);
		await test.room.expire();
		expect(test.store.record).not.toBeNull();
		expect(test.site.recoveries).toHaveLength(0);
	});

	it("keeps the state and tries again later when the recovery save fails", async () => {
		const test = new TestRoom();
		await leaveUncovered(test, "Unsaved");
		await advance(HOUR);
		test.site.rejectRecoveries = true;
		await test.room.expire();
		expect(test.store.record).not.toBeNull();
		test.site.rejectRecoveries = false;
		await test.room.expire();
		expect(test.site.recoveries).toHaveLength(1);
		expect(test.store.record).toBeNull();
	});

	it("leaves the largest fields out of a recovery revision over the size limit, and drops", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		test.site.forced = ["REFUSED", "REFUSED"];
		ana.type("Unsaved. ");
		// Each control character takes six bytes as JSON.
		ana.setField("title", "\u0001".repeat(MAX_RECOVERY_BYTES / 6 + 1));
		await advance(2000);
		ana.disconnect();
		await advance(10_000);
		await advance(HOUR);
		await test.room.expire();
		expect(test.site.recoveries).toHaveLength(1);
		expect(test.site.recoveries[0]?.data).not.toHaveProperty("title");
		expect(blocksText(test.site.recoveries[0]?.data.body)).toBe("Unsaved. First paragraph.");
		expect(test.store.record).toBeNull();
	});

	it("leaves saved fields out of a recovery revision over the size limit before unsaved ones", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.type("\u0001".repeat(MAX_RECOVERY_BYTES / 12));
		await advance(2000);
		expect(test.site.saves).toHaveLength(1);
		const title = "\u0001".repeat(MAX_RECOVERY_BYTES / 10);
		test.site.forced = ["REFUSED", "REFUSED"];
		ana.setField("title", title);
		await advance(2000);
		ana.disconnect();
		await advance(10_000);
		await advance(HOUR);
		await test.room.expire();
		expect(test.site.recoveries).toHaveLength(1);
		expect(test.site.recoveries[0]?.data).toEqual({ title });
		expect(test.store.record).toBeNull();
	});

	it("drops the state of an entry that's gone, with no recovery revision", async () => {
		const test = new TestRoom();
		await leaveUncovered(test, "Unsaved");
		test.site.remove();
		await advance(HOUR);
		await test.room.expire();
		expect(test.site.recoveries).toHaveLength(0);
		expect(test.store.record).toBeNull();
	});

	it("drops state past its hour before answering a token request", async () => {
		const test = new TestRoom();
		await leaveUncovered(test, "Unsaved");
		const lineage = test.store.record?.lineage;
		await advance(HOUR);
		const ben = await test.join("ben");
		expect(test.site.recoveries).toHaveLength(1);
		expect(ben.lineage).not.toBe(lineage);
		expect(ben.field("title")).toBe("Hello");
	});

	it("restarts the hour at each closed connection", async () => {
		const test = new TestRoom();
		await leaveUncovered(test, "Unsaved");
		await advance(HOUR - 20_000);
		const ben = await test.join("ben");
		ben.disconnect();
		await advance(30_000);
		await test.room.expire();
		expect(test.store.record).not.toBeNull();
	});
});

describe("restart and shutdown", () => {
	it("loads from storage at the next message after resuming a socket", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.type("Stored ");
		await advance(1000);
		const info = {
			userId: "ana",
			name: "Name ana",
			access: "edit" as const,
			connectedAt: Date.now(),
			clientId: null as number | null,
		};
		test.restart();
		test.room.resume(ana, info);
		ana.type("Resumed ");
		await settle();
		await advance(2000);
		expect(test.storedText()).toBe("Resumed Stored First paragraph.");
		expect(test.site.saves.at(-1)).toMatchObject({ actorId: "ana" });
		ana.announce([{ clientId: 7, clock: 1, state: {} }]);
		expect(info.clientId).toBe(7);
	});

	it("relays presence after resuming sockets without loading, and loads for an update", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const ben = await test.join("ben");
		ana.type("Stored ");
		await advance(1000);
		test.restart();
		test.room.resume(ana, resumedInfo("ana"));
		test.room.resume(ben, resumedInfo("ben"));
		test.store.calls = [];
		const loads = test.site.loads;
		ben.received = [];
		ana.announce([{ clientId: 7, clock: 1, state: { cursor: 3, user: { id: "ben" } } }]);
		await settle();
		expect(ben.awareness()).toEqual([
			{ clientId: 7, clock: 1, state: { cursor: 3, user: { id: "ana", name: "Name ana" } } },
		]);
		expect(test.site.loads).toBe(loads);
		expect(test.store.calls).not.toContain("load");

		ana.type("Resumed ");
		await settle();
		expect(test.store.calls).toContain("load");
		expect(ben.text()).toBe("Resumed Stored First paragraph.");
	});

	it("starts over with a recovery revision when a resumed room loads an entry with another hash", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", "Typed");
		await advance(1000);
		test.restart();
		test.room.resume(ana, {
			userId: "ana",
			name: "Name ana",
			access: "edit",
			connectedAt: Date.now(),
			clientId: null,
		});
		const entry = test.site.current;
		entry.hash = "schema-2";
		entry.fields.push({ slug: "subtitle", type: "string" });
		entry.data.subtitle = "Sub";
		ana.toRoom(encodeSyncStep1(ana.doc));
		await settle();
		await advance(3000);
		expect(ana.closed?.code).toBe(CLOSE_CODES.rejoin);
		expect(test.site.saves).toHaveLength(0);
		expect(test.site.recoveries).toMatchObject([{ data: { title: "Typed" } }]);
		expect(test.store.record).toBeNull();
		expect(entry.data).toMatchObject({ title: "Hello", subtitle: "Sub" });
	});

	it("touches storage at each close, claiming first after a restart, but not once it lost or gave up the claim", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const ben = await test.join("ben");
		ben.disconnect();
		await settle();
		expect(test.store.calls).toContain("touch");
		await test.room.shutdown();
		expect(test.store.calls.slice(test.store.calls.lastIndexOf("release"))).not.toContain("touch");
		const resumed = () => ({
			userId: "ana",
			name: "Name ana",
			access: "edit" as const,
			connectedAt: Date.now(),
			clientId: null,
		});
		test.restart();
		test.store.calls = [];
		test.room.resume(ana, resumed());
		ana.disconnect();
		await settle();
		expect(test.store.calls).toEqual(["claim", "touch"]);
		await advance(10_000);
		expect(test.store.claimed).toBe(false);

		const vic = await test.join("vic");
		vic.type("A ");
		test.store.claimLost = true;
		await advance(1000);
		expect(vic.closed?.code).toBe(CLOSE_CODES.rejoin);
		test.store.calls = [];
		test.room.resume(ana, resumed());
		ana.disconnect();
		await settle();
		expect(test.store.calls).not.toContain("touch");
	});

	it("names and merges an outside write that reaches a resumed socket's room", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		test.restart();
		test.room.resume(ana, resumedInfo("ana"));
		await test.site.write({ data: { title: "Outside" } }, ["seo"]);
		await settle();
		expect(ana.notices()).toContainEqual({ kind: "values", values: ["seo"] });
		expect(ana.field("title")).toBe("Outside");
	});

	it("saves an operation's kept checkpoint in a resumed socket's room", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", "Typed");
		await advance(1000);
		test.restart();
		test.room.resume(ana, resumedInfo("ana"));
		expect(await test.room.save("ben")).toMatchObject({ hold: expect.any(String) });
		expect(test.site.saves.at(-1)).toMatchObject({ actorId: "ben", kept: true });
		expect(test.site.current.data.title).toBe("Typed");
	});

	it("puts every field in the pending set after loading from storage", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.type("Stored ");
		ana.setField("title", "Stored title");
		await advance(1000);
		test.restart();
		await test.join("ben");
		await settle();
		expect(test.site.saves.at(-1)?.data).toMatchObject({ title: "Stored title" });
		expect(test.storedText()).toBe("Stored First paragraph.");
	});

	it("ends an operation's hold on shutdown instead of waiting for it", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		expect(await test.room.save("ana")).toMatchObject({ hold: expect.any(String) });
		ana.setField("title", "During");
		let finished = false;
		void test.room.shutdown().finally(() => {
			finished = true;
		});
		await settle();
		expect(finished).toBe(true);
		expect(test.site.current.data.title).toBe("During");
		expect(ana.closed?.code).toBe(CLOSE_CODES.rejoin);
	});

	it("stops applying updates, saves, releases its claim and closes with rejoin on shutdown", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		const ben = await test.join("ben");
		ana.setField("title", "Before shutdown");
		await settle();
		const shutdown = test.room.shutdown();
		ana.setField("title", "After shutdown");
		expect(await test.room.issueToken(test.claims("vic"))).toBe("busy");
		await shutdown;
		expect(ben.field("title")).toBe("Before shutdown");
		expect(test.site.current.data.title).toBe("Before shutdown");
		const stored = new Y.Doc();
		for (const update of test.store.updates) Y.applyUpdate(stored, update);
		expect(stored.getMap("fields").get("title")).toBe("Before shutdown");
		expect(test.store.claimed).toBe(false);
		expect(ana.closed?.code).toBe(CLOSE_CODES.rejoin);
		expect(ben.closed?.code).toBe(CLOSE_CODES.rejoin);
	});

	it("answers busy to a token request whose load was in flight when shutdown began, and saves what it loaded", async () => {
		const test = new TestRoom();
		const ana = await test.join("ana");
		ana.setField("title", "Stored");
		await advance(1000);
		test.restart();
		let open!: () => void;
		test.site.loadGate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const token = test.room.issueToken(test.claims("ana"));
		await settle();
		const shutdown = test.room.shutdown();
		open();
		expect(await token).toBe("busy");
		await shutdown;
		expect(test.site.current.data.title).toBe("Stored");
		expect(test.store.claimed).toBe(false);
	});
});
