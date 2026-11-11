import {
	decodeMessage,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeUpdate,
} from "@emdash-cms/admin/internal/co-editing";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { timestampOffset } from "../../../../src/database/repositories/entry-locks.js";
import type { Database } from "../../../../src/database/types.js";
import { isClaimedElsewhere, KyselyRoomStore } from "../../../../src/rooms/kysely-store.js";
import {
	CLAIM_RENEWAL_MS,
	ROOM_STATE_LIFETIME_MS,
	STORE_DELAY_MS,
	TOKEN_LIFETIME_MS,
} from "../../../../src/rooms/limits.js";
import { createRoomHost } from "../../../../src/rooms/node/index.js";
import { RoomRegistry, type AcceptedConnection } from "../../../../src/rooms/node/registry.js";
import { hasRoomNotifier } from "../../../../src/rooms/notifications.js";
import {
	CLOSE_CODES,
	roomId,
	type RoomConnection,
	type TokenClaims,
} from "../../../../src/rooms/types.js";
import { createTestRuntime } from "../../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../../utils/test-db.js";
import { FakeSite } from "../fake-site.js";
import {
	advance,
	BODY,
	BUILD,
	ENTRY,
	FINGERPRINT,
	paragraph,
	roomTimers,
	settle,
	TITLE,
	useRoomTimers,
} from "../test-room.js";

const cluster = vi.hoisted(() => ({ isWorker: false }));
vi.mock("node:cluster", () => ({ default: cluster }));

const ROOM = roomId(ENTRY);
const TICK_MS = CLAIM_RENEWAL_MS / 2;
const FROM_ROOM = Symbol("from-room");

/** A client socket speaking the room protocol through what the registry accepted. */
class FakeSocket implements RoomConnection {
	readonly doc = new Y.Doc();
	closed: { code: number; reason: string } | null = null;
	accepted: AcceptedConnection | null = null;

	constructor() {
		this.doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin !== FROM_ROOM) this.accepted?.receive(encodeUpdate(update));
		});
	}

	send(bytes: Uint8Array): void {
		const message = decodeMessage(bytes);
		if (message?.type === "sync-step-1") {
			queueMicrotask(() => this.accepted?.receive(encodeSyncStep2(this.doc, message.stateVector)));
		} else if (message?.type === "sync-step-2" || message?.type === "sync-update") {
			Y.applyUpdate(this.doc, message.update, FROM_ROOM);
		}
	}

	close(code: number, reason: string): void {
		this.closed ??= { code, reason };
	}
}

describe("RoomRegistry", () => {
	let db: Kysely<Database>;
	let site: FakeSite;
	let registries: RoomRegistry[];

	beforeEach(async () => {
		useRoomTimers();
		db = await setupTestDatabase();
		site = new FakeSite({
			fields: [TITLE, BODY],
			data: { title: "Hello", body: [paragraph("a", "First paragraph.")] },
		});
		registries = [];
	});

	afterEach(async () => {
		await Promise.allSettled(registries.map((registry) => registry.shutdown()));
		await settle();
		cluster.isWorker = false;
		vi.restoreAllMocks();
		vi.useRealTimers();
		await teardownTestDatabase(db);
	});

	/** A process's registry. After `crash`, its timers never fire and it never shuts down. */
	function start(): { registry: RoomRegistry; crash: () => void } {
		let dead = false;
		const registry = new RoomRegistry({
			db,
			site,
			build: BUILD,
			timers: {
				now: roomTimers.now,
				set: (ms, run) => roomTimers.set(ms, () => (dead ? undefined : run())),
			},
		});
		registries.push(registry);
		const crash = () => {
			dead = true;
			registries = registries.filter((each) => each !== registry);
		};
		return { registry, crash };
	}

	function claims(userId = "ana"): TokenClaims {
		const entry = site.current;
		return {
			userId,
			name: userId,
			access: "edit",
			fingerprint: FINGERPRINT,
			rev: entry.rev,
			status: entry.status,
			authorId: entry.authorId,
		};
	}

	async function token(registry: RoomRegistry, userId = "ana"): Promise<string> {
		const result = await registry.issueToken(ROOM, claims(userId));
		if (typeof result !== "object" || result === null) throw new Error(`No token: ${result}`);
		return result.token;
	}

	async function connect(registry: RoomRegistry, issued: string): Promise<FakeSocket> {
		const socket = new FakeSocket();
		socket.accepted = registry.accept(ROOM, issued, socket);
		socket.accepted?.receive(encodeSyncStep1(socket.doc));
		await settle();
		return socket;
	}

	function claimRow() {
		return db
			.selectFrom("_emdash_rooms")
			.select(["host", "record"])
			.where("room_id", "=", ROOM)
			.where("part", "=", 0)
			.executeTakeFirst();
	}

	/** Moves the room's claim or last write back on the database clock. */
	async function backdate(column: "claimed_at" | "updated_at", seconds: number): Promise<void> {
		const at = timestampOffset(db, -seconds);
		await db
			.updateTable("_emdash_rooms")
			.set(column === "claimed_at" ? { claimed_at: at } : { updated_at: at })
			.where("room_id", "=", ROOM)
			.where("part", "=", 0)
			.execute();
	}

	/** Whether a process other than the room's holder sees a live claim. */
	const claimIsLive = () => isClaimedElsewhere(db, ROOM, "another-process");

	it("takes the room's claim for a token", async () => {
		const { registry } = start();

		await token(registry);

		expect(await claimRow()).toMatchObject({ host: registry.host });
		expect(await registry.isOpen(ROOM)).toBe(true);
	});

	it("gives a second process on the same database busy, and the room counts as open there", async () => {
		const first = start().registry;
		const second = start().registry;
		await token(first);

		expect(await second.issueToken(ROOM, claims("ben"))).toBe("busy");
		expect(await second.isOpen(ROOM)).toBe(true);
		expect(await second.isOpen(roomId({ collection: "posts", id: "01OTHER" }))).toBe(false);
	});

	it("renews held claims on its tick, then drops rooms that closed", async () => {
		const { registry } = start();
		await token(registry);
		await backdate("claimed_at", 120);
		expect(await claimIsLive()).toBe(false);

		await advance(TICK_MS);

		expect(await claimIsLive()).toBe(true);
		expect(registry.size).toBe(1);

		await advance(TOKEN_LIFETIME_MS);
		expect(await claimRow()).toMatchObject({ host: null });
		await advance(TICK_MS);
		expect(registry.size).toBe(0);
	});

	it("keeps a room that is still taking its claim, so the tick renews the claim it gets", async () => {
		const claim = KyselyRoomStore.prototype.claim;
		let open!: () => void;
		const gate = new Promise<void>((resolve) => (open = resolve));
		vi.spyOn(KyselyRoomStore.prototype, "claim").mockImplementationOnce(
			async function (this: KyselyRoomStore) {
				await gate;
				return claim.call(this);
			},
		);
		const { registry } = start();

		const issued = registry.issueToken(ROOM, claims());
		await advance(TICK_MS);
		expect(registry.size).toBe(1);
		open();
		expect(await issued).toEqual({ token: expect.any(String) });

		await backdate("claimed_at", 120);
		await advance(TICK_MS);
		expect(await claimIsLive()).toBe(true);
	});

	it("drops the state of a room a crashed process left, saving a recovery revision", async () => {
		const crashed = start();
		const socket = await connect(crashed.registry, await token(crashed.registry));
		socket.doc.getMap("fields").set(TITLE.slug, "Unsaved");
		await advance(STORE_DELAY_MS);
		crashed.crash();
		await backdate("updated_at", ROOM_STATE_LIFETIME_MS / 1000 + 1);
		await backdate("claimed_at", 120);

		await start().registry.expireIdle();
		await settle();

		expect(site.saves).toEqual([]);
		expect(site.recoveries).toEqual([
			expect.objectContaining({
				data: expect.objectContaining({ title: "Unsaved" }),
				editedBy: ["ana"],
			}),
		]);
		expect(await claimRow()).toBeUndefined();
	});

	it("releases its claims, closes connections and refuses tokens and sockets once shut down", async () => {
		const { registry } = start();
		const socket = await connect(registry, await token(registry));

		await registry.shutdown();

		expect(socket.closed?.code).toBe(CLOSE_CODES.rejoin);
		expect(await claimRow()).toMatchObject({ host: null });
		expect(await registry.issueToken(ROOM, claims())).toBe("busy");
		const late = new FakeSocket();
		expect(registry.accept(ROOM, "any", late)).toBeNull();
		expect(late.closed?.code).toBe(CLOSE_CODES.busy);
		expect(await token(start().registry)).toEqual(expect.any(String));
	});

	it("closes a socket with busy when this process has no room for it or the token isn't valid", async () => {
		const { registry } = start();
		const elsewhere = new FakeSocket();
		expect(registry.accept(ROOM, "any", elsewhere)).toBeNull();
		expect(elsewhere.closed?.code).toBe(CLOSE_CODES.busy);

		await token(registry);
		const forged = new FakeSocket();
		expect(registry.accept(ROOM, "forged", forged)).toBeNull();
		expect(forged.closed?.code).toBe(CLOSE_CODES.busy);
	});

	it("queues a notification's merge before a later call in the same request reaches the room", async () => {
		const { registry } = start();
		await connect(registry, await token(registry));
		site.change({ data: { title: "Outside" } });

		void registry.notify(ROOM, []);
		const held = await registry.save(ROOM, "ana", site.current.rev);

		expect(held).toEqual({ rev: site.current.rev, hold: expect.any(String) });
		if (held && held !== "conflict") await registry.release(ROOM, held.hold);
	});

	it("answers for rooms this process doesn't keep without creating them", async () => {
		const { registry } = start();

		expect(await registry.save(ROOM, "ana")).toBeNull();
		await registry.release(ROOM, "hold");
		await registry.notify(ROOM, ["seo"]);
		await registry.forgetTokens(ROOM, "ana");
		expect(registry.size).toBe(0);
		expect(await registry.issueToken("not-a-room-id", claims())).toBeNull();
	});

	it("hears outside writes once activated, until it shuts down, and leaves a newer registry's slot", async () => {
		const older = start().registry;
		const newer = start().registry;

		older.activate();
		expect(hasRoomNotifier()).toBe(true);
		newer.activate();
		await older.shutdown();
		expect(hasRoomNotifier()).toBe(true);
		await newer.shutdown();
		expect(hasRoomNotifier()).toBe(false);
	});
});

describe("createRoomHost", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		cluster.isWorker = false;
		await teardownTestDatabase(db);
	});

	it("gives a node:cluster worker no host", () => {
		const runtime = createTestRuntime(db);
		expect(createRoomHost(runtime)).toBeInstanceOf(RoomRegistry);

		cluster.isWorker = true;
		expect(createRoomHost(runtime)).toBeNull();
	});
});
