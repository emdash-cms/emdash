import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { timestampOffset } from "../../../src/database/repositories/entry-locks.js";
import {
	isClaimedElsewhere,
	KyselyRoomStore,
	listExpiredRooms,
} from "../../../src/rooms/kysely-store.js";
import { COMPACTION_BYTES } from "../../../src/rooms/limits.js";
import {
	RoomClaimLostError,
	roomId,
	type RoomRecord,
	type RoomStore,
} from "../../../src/rooms/types.js";
import { MemoryRoomStore } from "../../unit/rooms/memory-store.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const ROOM = roomId({ collection: "posts", id: "01JXENTRY0000000000000000" });
const HOUR_SECONDS = 60 * 60;
const HOUR_MS = HOUR_SECONDS * 1000;
/** How far apart two readings of "now" may be in one test. */
const SLACK_MS = 5000;

function record(overrides: Partial<RoomRecord> = {}): RoomRecord {
	return {
		lineage: "lineage-1",
		fingerprint: { version: "1.0.0", commit: "abc123", hash: "schema-1" },
		checkpoint: "AAEC",
		mergeBase: { rev: "rev-1", stored: { title: "h1" }, document: { title: "h1" } },
		editors: [],
		status: "draft",
		authorId: null,
		...overrides,
	};
}

/** Bytes that repeat only every 251, so a part out of place changes them. */
function pattern(length: number, seed = 0): Uint8Array {
	const bytes = new Uint8Array(length);
	for (let index = 0; index < length; index++) bytes[index] = (index + seed) % 251;
	return bytes;
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
	return a !== undefined && Buffer.from(a).equals(Buffer.from(b));
}

/** What the room observes from a run of every store call it makes. */
async function observe(store: RoomStore): Promise<unknown[]> {
	const seen: unknown[] = [];
	const look = async () => {
		const { record: stored, updates, updatedAt } = await store.load();
		seen.push({
			record: stored,
			updates: updates.map((update) => [...update]),
			hasUpdatedAt: updatedAt !== null,
		});
	};
	seen.push(await store.claim(), await store.claim());
	await look();
	await store.touch();
	await look();
	await store.writeRecord(record(), Uint8Array.of(1, 2));
	await look();
	await store.append([Uint8Array.of(3), Uint8Array.of(4, 5)]);
	await store.append([]);
	await look();
	await store.writeRecord(record({ editors: ["ana"] }));
	await look();
	await store.compact(Uint8Array.of(9, 9));
	await store.append([Uint8Array.of(6)]);
	await look();
	await store.touch();
	seen.push(await store.renew());
	await store.drop();
	await look();
	await store.release();
	seen.push(await store.claim());
	return seen;
}

describeEachDialect("room store", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownForDialect(ctx);
	});

	function store(host = "host-a", id = ROOM): KyselyRoomStore {
		return new KyselyRoomStore(ctx.db, id, host);
	}

	/** Moves a room's claim or last write back by `seconds` on the database clock. */
	async function backdate(
		column: "claimed_at" | "updated_at",
		seconds: number,
		id = ROOM,
	): Promise<void> {
		const at = timestampOffset(ctx.db, -seconds);
		await ctx.db
			.updateTable("_emdash_rooms")
			.set(column === "claimed_at" ? { claimed_at: at } : { updated_at: at })
			.where("room_id", "=", id)
			.where("part", "=", 0)
			.execute();
	}

	function roomRows() {
		return ctx.db
			.selectFrom("_emdash_rooms")
			.select(["part", "host", "claimed_at"])
			.where("room_id", "=", ROOM)
			.orderBy("part")
			.execute();
	}

	it("answers every call the room makes as the memory store does", async () => {
		const expected = await observe(new MemoryRoomStore());

		expect(await observe(store())).toEqual(expected);
		expect(expected).toContainEqual({
			record: record({ editors: ["ana"] }),
			updates: [[1, 2], [3], [4, 5]],
			hasUpdatedAt: true,
		});
	});

	it("stores values over 1 MB in parts and reads them back as plain Uint8Arrays", async () => {
		const subject = store();
		await subject.claim();
		const big = pattern(2 * COMPACTION_BYTES + 5);
		const exact = pattern(COMPACTION_BYTES, 7);
		const empty = JSON.stringify(record({ checkpoint: "" }));
		const start = empty.indexOf('"checkpoint":"') + '"checkpoint":"'.length;
		// Puts a surrogate pair across the first part boundary.
		const checkpoint = `${"x".repeat(COMPACTION_BYTES - 1 - start)}😀${"y".repeat(COMPACTION_BYTES)}`;

		await subject.writeRecord(record({ checkpoint }), big);
		await subject.append([exact, Uint8Array.of(1)]);
		const loaded = await subject.load();

		expect(loaded.record?.checkpoint === checkpoint).toBe(true);
		expect({ ...loaded.record, checkpoint: "" }).toEqual(record({ checkpoint: "" }));
		expect(loaded.updates.map((update) => update.byteLength)).toEqual([
			big.byteLength,
			exact.byteLength,
			1,
		]);
		expect(sameBytes(loaded.updates[0], big)).toBe(true);
		expect(sameBytes(loaded.updates[1], exact)).toBe(true);
		expect(sameBytes(loaded.updates[2], Uint8Array.of(1))).toBe(true);
		for (const update of loaded.updates) {
			expect(Object.getPrototypeOf(update)).toBe(Uint8Array.prototype);
		}

		const updateRows = await ctx.db
			.selectFrom("_emdash_room_updates")
			.select(["seq", "part", "data"])
			.where("room_id", "=", ROOM)
			.orderBy("seq")
			.orderBy("part")
			.execute();
		expect(updateRows.map((row) => [row.seq, row.part, row.data.byteLength])).toEqual([
			[0, 0, COMPACTION_BYTES],
			[0, 1, COMPACTION_BYTES],
			[0, 2, 5],
			[1, 0, COMPACTION_BYTES],
			[2, 0, 1],
		]);
		const recordRows = await ctx.db
			.selectFrom("_emdash_rooms")
			.select("record")
			.where("room_id", "=", ROOM)
			.orderBy("part")
			.execute();
		const utf8Length = (text: string | null | undefined) =>
			new TextEncoder().encode(text ?? "").byteLength;
		expect(recordRows.map((row) => utf8Length(row.record))).toEqual([
			COMPACTION_BYTES - 1,
			COMPACTION_BYTES,
			utf8Length(JSON.stringify(record({ checkpoint }))) - (2 * COMPACTION_BYTES - 1),
		]);
		expect(recordRows[0]?.record?.endsWith("x")).toBe(true);
		expect(recordRows[1]?.record?.startsWith("😀")).toBe(true);
	});

	it("keeps a live claim from a second host, which takes it once it expires", async () => {
		const first = store("host-a");
		const second = store("host-b");
		expect(await isClaimedElsewhere(ctx.db, ROOM, "host-b")).toBe(false);

		expect(await first.claim()).toBe(true);
		await first.writeRecord(record(), Uint8Array.of(1));
		expect(await second.claim()).toBe(false);
		expect(await isClaimedElsewhere(ctx.db, ROOM, "host-b")).toBe(true);
		expect(await isClaimedElsewhere(ctx.db, ROOM, "host-a")).toBe(false);
		expect(await second.renew()).toBe(false);
		await expect(second.load()).rejects.toBeInstanceOf(RoomClaimLostError);

		await backdate("claimed_at", 61);
		expect(await isClaimedElsewhere(ctx.db, ROOM, "host-b")).toBe(false);
		expect(await second.claim()).toBe(true);
		expect(await second.load()).toMatchObject({ record: record(), updates: [Uint8Array.of(1)] });
		expect(await isClaimedElsewhere(ctx.db, ROOM, "host-a")).toBe(true);
	});

	it("rejects every write from a host that lost its claim, and keeps the new holder's state", async () => {
		const first = store("host-a");
		const second = store("host-b");
		await first.claim();
		await first.writeRecord(record(), Uint8Array.of(1));
		await backdate("claimed_at", 61);
		await second.claim();

		expect(await first.renew()).toBe(false);
		await expect(first.load()).rejects.toBeInstanceOf(RoomClaimLostError);
		await expect(first.append([Uint8Array.of(2)])).rejects.toBeInstanceOf(RoomClaimLostError);
		await expect(
			first.writeRecord(record({ editors: ["ana"] }), Uint8Array.of(3)),
		).rejects.toBeInstanceOf(RoomClaimLostError);
		await expect(first.compact(Uint8Array.of(4))).rejects.toBeInstanceOf(RoomClaimLostError);
		await expect(first.touch()).rejects.toBeInstanceOf(RoomClaimLostError);
		await expect(first.drop()).rejects.toBeInstanceOf(RoomClaimLostError);
		await first.release();

		expect(await second.load()).toMatchObject({ record: record(), updates: [Uint8Array.of(1)] });
		expect(await isClaimedElsewhere(ctx.db, ROOM, "host-a")).toBe(true);
	});

	it("renews the claim with renew and with every other call but release", async () => {
		const first = store("host-a");
		const second = store("host-b");
		await first.claim();
		const calls: Record<string, () => Promise<unknown>> = {
			writeRecord: () => first.writeRecord(record()),
			renew: () => first.renew(),
			load: () => first.load(),
			append: () => first.append([Uint8Array.of(1)]),
			compact: () => first.compact(Uint8Array.of(2)),
			touch: () => first.touch(),
			drop: () => first.drop(),
		};
		for (const [name, call] of Object.entries(calls)) {
			await backdate("claimed_at", 120);
			await call();
			expect(await second.claim(), name).toBe(false);
		}
	});

	it("releases only its own claim, and deletes a row with no record", async () => {
		const first = store("host-a");
		const second = store("host-b");
		await first.claim();
		await first.release();
		expect(await roomRows()).toEqual([]);

		await first.claim();
		await first.writeRecord(record());
		await first.release();
		expect(await roomRows()).toEqual([{ part: 0, host: null, claimed_at: null }]);
		expect(await second.claim()).toBe(true);

		await first.release();
		await second.drop();
		await first.release();
		expect(await isClaimedElsewhere(ctx.db, ROOM, "host-a")).toBe(true);
		await second.release();
		expect(await roomRows()).toEqual([]);
	});

	it("moves updatedAt with every write and touch, but not with load or renew", async () => {
		const subject = store();
		await subject.claim();
		await subject.writeRecord(record());
		const age = async () => Date.now() - ((await subject.load()).updatedAt ?? Number.NaN);
		const writes: Record<string, () => Promise<void>> = {
			append: () => subject.append([Uint8Array.of(1)]),
			writeRecord: () => subject.writeRecord(record()),
			compact: () => subject.compact(Uint8Array.of(2)),
			touch: () => subject.touch(),
		};
		for (const [name, write] of Object.entries(writes)) {
			await backdate("updated_at", 2 * HOUR_SECONDS);
			expect(Math.abs((await age()) - 2 * HOUR_MS), name).toBeLessThan(SLACK_MS);
			await write();
			expect(Math.abs(await age()), name).toBeLessThan(SLACK_MS);
		}

		await backdate("updated_at", 2 * HOUR_SECONDS);
		await subject.renew();
		expect(Math.abs((await age()) - 2 * HOUR_MS)).toBeLessThan(SLACK_MS);
		await subject.drop();
		expect((await subject.load()).updatedAt).toBeNull();
	});

	it("reports updatedAt on the process clock", async () => {
		const subject = store();
		await subject.claim();
		await subject.writeRecord(record());
		await backdate("updated_at", 2 * HOUR_SECONDS);
		const now = Date.now() + 3 * HOUR_MS;
		vi.spyOn(Date, "now").mockReturnValue(now);

		const { updatedAt } = await subject.load();

		expect(Math.abs(now - 2 * HOUR_MS - (updatedAt ?? Number.NaN))).toBeLessThan(SLACK_MS);
	});

	it("lists rooms past their hour whose claim is free, expired or this host's", async () => {
		const id = (name: string) => roomId({ collection: "posts", id: name });
		const stored = async (name: string, host: string) => {
			const subject = store(host, id(name));
			await subject.claim();
			await subject.writeRecord(record());
			return subject;
		};
		await (await stored("free", "host-b")).release();
		await stored("held-elsewhere", "host-b");
		await stored("expired-elsewhere", "host-b");
		await stored("ours", "host-a");
		await (await stored("recent", "host-b")).release();
		await store("host-b", id("empty")).claim();
		for (const name of ["free", "held-elsewhere", "expired-elsewhere", "ours", "empty"]) {
			await backdate("updated_at", HOUR_SECONDS + 1, id(name));
		}
		await backdate("updated_at", HOUR_SECONDS / 2, id("recent"));
		await backdate("claimed_at", 61, id("expired-elsewhere"));

		const listed = await listExpiredRooms(ctx.db, "host-a");

		expect(listed.toSorted()).toEqual([id("expired-elsewhere"), id("free"), id("ours")]);
	});
});
