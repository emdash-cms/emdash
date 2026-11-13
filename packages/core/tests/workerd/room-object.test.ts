import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { EmDashRoom } from "../../../cloudflare/src/rooms/object.js";
import { CLOSE_CODES } from "../../src/rooms/types.js";
import { blocksText, claims, newRoom, RoomClient } from "./room-object-client.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A socket's attachment, as `EmDashRoom` writes it. */
interface Attachment {
	info: { userId: string; connectedAt: number };
	seenAt: number;
}

/** Moves back when a user's sockets last sent a message, as their attachments keep it. */
function silence(stub: DurableObjectStub<EmDashRoom>, userId: string, ms: number) {
	return runInDurableObject(stub, (_instance, state) => {
		for (const ws of state.getWebSockets()) {
			const attachment = ws.deserializeAttachment() as Attachment | null;
			if (attachment?.info.userId !== userId) continue;
			ws.serializeAttachment({ ...attachment, seenAt: attachment.seenAt - ms });
		}
	});
}

function storage(stub: DurableObjectStub<EmDashRoom>) {
	return runInDurableObject(stub, async (_instance, state) => {
		const sql = state.storage.sql;
		const tables = sql
			.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
			.toArray()
			.map((row) => row.name)
			.filter((name) => name.startsWith("_emdash_"));
		const count = (table: string) =>
			tables.includes(table)
				? sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n
				: 0;
		return {
			tables,
			records: count("_emdash_rooms"),
			updates: count("_emdash_room_updates"),
			alarm: await state.storage.getAlarm(),
		};
	});
}

/** Waits until the object has handled every socket's close. */
async function closed(stub: DurableObjectStub<EmDashRoom>): Promise<void> {
	await vi.waitFor(async () => {
		const open = await runInDurableObject(stub, (_instance, state) => state.getWebSockets().length);
		expect(open).toBe(0);
	});
	await wait(50);
}

describe("EmDashRoom", () => {
	it("relays edits between two clients, stores them, and saves through the site", async () => {
		const { site, stub } = newRoom();
		const ana = await RoomClient.join(stub, site, "ana");
		const ben = await RoomClient.join(stub, site, "ben");
		const rev = site.current.rev;
		ana.type("Ana ");
		await vi.waitFor(() => expect(ben.text()).toBe("Ana First paragraph."));
		ben.type("Ben ");
		await vi.waitFor(() => expect(ana.text()).toBe("Ben Ana First paragraph."));
		await vi.waitFor(() => expect(blocksText(site.current.data.body)).toBe(ana.text()), {
			timeout: 5000,
		});
		expect(site.saves[0]).toMatchObject({ rev, actorId: expect.any(String) });
		expect((await storage(stub)).updates).toBeGreaterThan(1);
		ana.close();
		ben.close();
	});

	it("resumes hibernated sockets with their attachments, relays presence without loading, and loads for an update", async () => {
		const { site, stub } = newRoom();
		const ana = await RoomClient.join(stub, site, "ana");
		const ben = await RoomClient.join(stub, site, "ben");
		const vic = await RoomClient.join(stub, site, "vic");
		ana.announce([{ clientId: 7, clock: 1, state: { cursor: 1 } }]);
		await vi.waitFor(() => expect(ben.awareness()).toHaveLength(1));
		ana.type("Stored ");
		await vi.waitFor(() => expect(site.saves).toHaveLength(1), { timeout: 5000 });
		vic.send(new Uint8Array([255, 255]));
		await vi.waitFor(() => expect(vic.closed?.code).toBe(CLOSE_CODES.reset));

		await evictDurableObject(stub);
		const loads = site.loads;
		ben.received.length = 0;
		vic.received.length = 0;
		ana.announce([
			{ clientId: 8, clock: 1, state: { cursor: 9 } },
			{ clientId: 7, clock: 2, state: { cursor: 2 } },
		]);
		await vi.waitFor(() => expect(ben.awareness()).toHaveLength(1));
		expect(ben.awareness()[0]).toEqual({
			clientId: 7,
			clock: 2,
			state: { cursor: 2, user: { id: "ana", name: "Name ana" } },
		});
		expect(site.loads).toBe(loads);

		ben.type("Resumed ");
		await vi.waitFor(() => expect(ana.text()).toBe("Resumed Stored First paragraph."));
		expect(site.loads).toBe(loads + 1);
		expect(vic.received).toHaveLength(0);

		await evictDurableObject(stub);
		await stub.notify(["seo"]);
		await vi.waitFor(() =>
			expect(ana.received).toContainEqual({
				type: "notice",
				notice: { kind: "values", values: ["seo"] },
			}),
		);
		ana.close();
		ben.close();
	});

	it("closes a socket without a valid token with busy", async () => {
		const { stub } = newRoom();
		const client = new RoomClient("ana");
		await client.upgrade(stub, "not-a-token");
		await vi.waitFor(() => expect(client.closed?.code).toBe(CLOSE_CODES.busy));
	});

	it("closes a socket whose info can't be kept with busy", async () => {
		const { site, stub } = newRoom();
		const issued = await stub.issueToken({ ...claims(site, "ana"), name: "a".repeat(20_000) });
		if (typeof issued !== "object" || issued === null) throw new Error("No token");
		const client = new RoomClient("ana");
		await client.upgrade(stub, issued.token);
		await vi.waitFor(() => expect(client.closed?.code).toBe(CLOSE_CODES.busy));
		// The refused socket doesn't count toward the user's five connections.
		for (let i = 0; i < 5; i++) {
			expect(await stub.issueToken(claims(site, "ana"))).toMatchObject({
				token: expect.any(String),
			});
		}
	});

	const LIMIT = 2 * 1024 * 1024;
	it.each([
		["binary", new Uint8Array(LIMIT + 1)],
		["text", "a".repeat(LIMIT + 1)],
		// Fewer UTF-16 code units than the limit, but more bytes of UTF-8.
		["multibyte text", "漢".repeat(Math.ceil((LIMIT + 1) / 3))],
	])("closes a socket that sends %s over the size limit with 1009", async (_kind, message) => {
		const { site, stub } = newRoom();
		const ana = await RoomClient.join(stub, site, "ana");
		ana.send(message);
		await vi.waitFor(() => expect(ana.closed?.code).toBe(1009));
	});

	it("leaves no storage for an entry whose room never stored", async () => {
		const { stub } = newRoom();
		expect(await stub.isOpen()).toBe(false);
		await stub.notify(["seo"]);
		expect(await storage(stub)).toEqual({ tables: [], records: 0, updates: 0, alarm: null });
	});

	it("keeps stored updates across a restart", async () => {
		const { site, stub } = newRoom();
		site.forced = Array.from({ length: 10 }, () => "REFUSED" as const);
		const ana = await RoomClient.join(stub, site, "ana");
		ana.type("Unsaved ");
		await vi.waitFor(async () => expect((await storage(stub)).updates).toBeGreaterThan(1), {
			timeout: 5000,
		});
		ana.close();
		await closed(stub);
		await evictDurableObject(stub);
		expect(blocksText(site.current.data.body)).toBe("First paragraph.");
		site.forced = [];
		const ben = await RoomClient.join(stub, site, "ben");
		expect(ben.text()).toBe("Unsaved First paragraph.");
		ben.close();
	});
});

describe("EmDashRoom alarm", () => {
	/** Leaves uncovered updates in storage with no connections, past their hour, on a fresh instance. */
	async function leaveExpired() {
		const room = newRoom();
		const { site, stub } = room;
		site.forced = Array.from({ length: 10 }, () => "REFUSED" as const);
		const ana = await RoomClient.join(stub, site, "ana");
		ana.setField("title", "Unsaved");
		await vi.waitFor(async () => expect((await storage(stub)).updates).toBeGreaterThan(1), {
			timeout: 5000,
		});
		ana.close();
		await closed(stub);
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("UPDATE _emdash_rooms SET updated_at = updated_at - ?", HOUR + MINUTE);
		});
		await evictDurableObject(stub);
		return room;
	}

	it("saves uncovered state as a recovery revision and drops it when the alarm fires", async () => {
		const { site, stub } = await leaveExpired();
		await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now() + 100));
		await evictDurableObject(stub);
		await vi.waitFor(() => expect(site.recoveries).toHaveLength(1), { timeout: 5000 });
		expect(site.recoveries[0]).toMatchObject({ data: { title: "Unsaved" }, editedBy: ["ana"] });
		expect(site.current.data.title).toBe("Hello");
		await vi.waitFor(async () => {
			expect(await storage(stub)).toEqual({ tables: [], records: 0, updates: 0, alarm: null });
		});
	});

	it("keeps the state and sets the alarm again when the recovery save fails", async () => {
		const { site, stub } = await leaveExpired();
		site.rejectRecoveries = true;
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		const after = await storage(stub);
		expect(after.records).toBeGreaterThan(0);
		expect(after.alarm).toBeGreaterThan(Date.now() + HOUR - MINUTE);
	});

	it("sets itself again while the room is open", async () => {
		const { site, stub } = newRoom();
		const ana = await RoomClient.join(stub, site, "ana");
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect((await storage(stub)).alarm).toBeGreaterThan(Date.now() + HOUR - MINUTE);
		expect(ana.closed).toBeNull();
		ana.close();
	});

	it("closes resumed sockets past their lifetime with rejoin", async () => {
		const { site, stub } = newRoom();
		const ana = await RoomClient.join(stub, site, "ana");
		await runInDurableObject(stub, (_instance, state) => {
			for (const ws of state.getWebSockets()) {
				const attachment = ws.deserializeAttachment() as Attachment;
				const connectedAt = attachment.info.connectedAt - 16 * MINUTE;
				ws.serializeAttachment({ ...attachment, info: { ...attachment.info, connectedAt } });
			}
		});
		await evictDurableObject(stub);
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		await vi.waitFor(() => expect(ana.closed?.code).toBe(CLOSE_CODES.rejoin));
	});
});

describe("EmDashRoom silent sockets", () => {
	it("closes a resumed socket that sent nothing for 3 minutes, and stays open for a fresh one", async () => {
		const { site, stub } = newRoom();
		const ana = await RoomClient.join(stub, site, "ana");
		const ben = await RoomClient.join(stub, site, "ben");
		await silence(stub, "ben", 4 * MINUTE);
		await evictDurableObject(stub);
		expect(await stub.isOpen()).toBe(true);
		await vi.waitFor(() => expect(ben.closed?.code).toBe(1001));
		expect(ana.closed).toBeNull();
		ana.close();
	});

	it("answers closed once its only socket went silent", async () => {
		const { site, stub } = newRoom();
		const ana = await RoomClient.join(stub, site, "ana");
		await silence(stub, "ana", 4 * MINUTE);
		await evictDurableObject(stub);
		await stub.isOpen();
		await vi.waitFor(() => expect(ana.closed?.code).toBe(1001));
		// As after any last close, the room stays open for 10 s.
		await vi.waitFor(async () => expect(await stub.isOpen()).toBe(false), {
			timeout: 15_000,
			interval: 500,
		});
	});

	it("goes by each socket's last message, not the time its attachment last stored", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const start = Date.now();
			const { site, stub } = newRoom();
			const ana = await RoomClient.join(stub, site, "ana");
			const ben = await RoomClient.join(stub, site, "ben");
			vi.setSystemTime(start + 20 * SECOND);
			ana.announce([{ clientId: 7, clock: 1, state: {} }]);
			await vi.waitFor(() => expect(ben.awareness()).toHaveLength(1));
			vi.setSystemTime(start + 190 * SECOND);
			expect(await stub.isOpen()).toBe(true);
			await vi.waitFor(() => expect(ben.closed?.code).toBe(1001));
			expect(ana.closed).toBeNull();
			ana.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a silent socket whose message arrives, through the next wake", async () => {
		const { site, stub } = newRoom();
		const ana = await RoomClient.join(stub, site, "ana");
		const ben = await RoomClient.join(stub, site, "ben");
		ana.announce([{ clientId: 7, clock: 1, state: {} }]);
		await vi.waitFor(() => expect(ben.awareness()).toHaveLength(1));
		await silence(stub, "ana", 4 * MINUTE);
		await evictDurableObject(stub);
		ana.announce([{ clientId: 7, clock: 2, state: {} }]);
		await vi.waitFor(() => expect(ben.awareness()).toHaveLength(2));
		await evictDurableObject(stub);
		expect(await stub.isOpen()).toBe(true);
		await wait(50);
		expect(ana.closed).toBeNull();
		ana.close();
		ben.close();
	});
});

describe("EmDashRoom storage failure", () => {
	it("closes its connections, and answers token requests with null", async () => {
		const { site, stub } = newRoom();
		const ana = await RoomClient.join(stub, site, "ana");
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("DROP TABLE _emdash_room_updates");
		});
		ana.type("Lost ");
		await vi.waitFor(() => expect(ana.closed?.code).toBe(CLOSE_CODES.reset), { timeout: 5000 });
		expect(await stub.issueToken(claims(site, "ben"))).toBeNull();
	});
});
