/**
 * Measures CPU time per room save, merge and notification on the Node.js host: the room registry,
 * a room site over a runtime, and room storage in a SQLite database, as a site runs them. Skipped
 * unless ROOM_CPU=1:
 *
 *   ROOM_CPU=1 pnpm --filter emdash exec vitest run tests/integration/rooms/cpu-time.test.ts
 *
 * `process.cpuUsage()` counts every thread in the process, so each number includes the database
 * work, which `node:sqlite` does on the calling thread against an in-memory database, V8's
 * background garbage collection, and the test client decoding what the room sends it. The thread
 * columns leave out other threads, and the site column is the part spent in the site's load or
 * save, which holds the entry's own database reads and writes.
 */
import {
	decodeMessage,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeUpdate,
	fragmentName,
} from "@emdash-cms/admin/internal/co-editing";
import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { encodeRev } from "../../../src/api/rev.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { Database } from "../../../src/database/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { runInFreshRequestContext } from "../../../src/request-context.js";
import { SAVE_DELAY_MS } from "../../../src/rooms/limits.js";
import { RoomRegistry, type AcceptedConnection } from "../../../src/rooms/node/registry.js";
import { clearRoomNotifier, setRoomNotifier } from "../../../src/rooms/notifications.js";
import { createRoomSite } from "../../../src/rooms/site.js";
import {
	roomId,
	type RoomConnection,
	type RoomSite,
	type RoomTimers,
} from "../../../src/rooms/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const ENABLED = process.env.ROOM_CPU === "1";
const ITERATIONS = Number(process.env.ROOM_CPU_ITERATIONS ?? 200);
const WARMUP = Number(process.env.ROOM_CPU_WARMUP ?? 30);
/** Calls per sample for operations too short to time one at a time. */
const BATCH = 1000;
const WORDS = 2000;

const BUILD = { version: "1.0.0", commit: "abc123" };
const EDITOR = "user_editor";
const FROM_ROOM = Symbol("from-room");

/** Timers the test fires by hand, so a save starts exactly when it is measured. */
class ManualTimers implements RoomTimers {
	readonly #pending = new Set<{ ms: number; run: () => void }>();

	now(): number {
		return Date.now();
	}

	set(ms: number, run: () => void): () => void {
		const timer = { ms, run };
		this.#pending.add(timer);
		return () => this.#pending.delete(timer);
	}

	/** Runs the timers set for `ms`, not ones they set, and returns how many ran. */
	fire(ms: number): number {
		const due = [...this.#pending].filter((timer) => timer.ms === ms);
		for (const timer of due) {
			this.#pending.delete(timer);
			timer.run();
		}
		return due.length;
	}
}

/** A client socket speaking the room protocol through what the registry accepted. */
class ClientSocket implements RoomConnection {
	readonly doc = new Y.Doc();
	accepted: AcceptedConnection | null = null;
	#checkpoint: (() => void) | null = null;

	constructor() {
		this.doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin !== FROM_ROOM) this.accepted?.receive(encodeUpdate(update));
		});
	}

	nextCheckpoint(): Promise<void> {
		return new Promise((resolve) => (this.#checkpoint = resolve));
	}

	send(bytes: Uint8Array): void {
		const message = decodeMessage(bytes);
		if (message?.type === "sync-step-1") {
			queueMicrotask(() => this.accepted?.receive(encodeSyncStep2(this.doc, message.stateVector)));
		} else if (message?.type === "sync-step-2" || message?.type === "sync-update") {
			Y.applyUpdate(this.doc, message.update, FROM_ROOM);
		} else if (message?.type === "checkpoint") {
			this.#checkpoint?.();
			this.#checkpoint = null;
		}
	}

	close(): void {}
}

const VOCABULARY =
	"the room keeps every editor's changes in one shared document and saves them to the entry as a draft while people type so nobody loses work when a tab closes".split(
		" ",
	);

/** About `words` words of rich text: headed sections of paragraphs, some words bold or italic. */
function typicalBody(words: number): unknown[] {
	const blocks: unknown[] = [];
	let written = 0;
	let key = 0;
	const text = (count: number) =>
		Array.from({ length: count }, (_, i) => VOCABULARY[(written + i) % VOCABULARY.length]).join(
			" ",
		);
	while (written < words) {
		if (blocks.length % 6 === 0) {
			blocks.push({
				_type: "block",
				_key: `b${key++}`,
				style: "h2",
				markDefs: [],
				children: [{ _type: "span", _key: `s${key++}`, text: text(5), marks: [] }],
			});
			written += 5;
			continue;
		}
		const spans = [
			{ _type: "span", _key: `s${key++}`, text: `${text(40)} `, marks: [] },
			{ _type: "span", _key: `s${key++}`, text: text(6), marks: [key % 2 ? "strong" : "em"] },
			{ _type: "span", _key: `s${key++}`, text: ` ${text(54)}`, marks: [] },
		];
		blocks.push({
			_type: "block",
			_key: `b${key++}`,
			style: "normal",
			markDefs: [],
			children: spans,
		});
		written += 100;
	}
	return blocks;
}

interface Sample {
	cpu: number;
	/** This thread's CPU alone, without V8's background threads, where Node.js reports it. */
	threadCpu: number | undefined;
	wall: number;
}

/** Node.js 23.9 added `threadCpuUsage`. */
const hasThreadCpuUsage = typeof process.threadCpuUsage === "function";

const milliseconds = (usage: NodeJS.CpuUsage) => (usage.user + usage.system) / 1000;

async function measure(run: () => Promise<unknown>, calls = 1): Promise<Sample> {
	const startWall = performance.now();
	const startThreadCpu = hasThreadCpuUsage ? process.threadCpuUsage() : undefined;
	const startCpu = process.cpuUsage();
	await run();
	const cpu = process.cpuUsage(startCpu);
	const threadCpu = startThreadCpu ? process.threadCpuUsage(startThreadCpu) : undefined;
	const wall = performance.now() - startWall;
	return {
		cpu: milliseconds(cpu) / calls,
		threadCpu: threadCpu ? milliseconds(threadCpu) / calls : undefined,
		wall: wall / calls,
	};
}

function percentile(sorted: number[], p: number): number {
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
}

function summarize(name: string, samples: Sample[], siteCpu?: number[]) {
	const cpu = samples.map((s) => s.cpu).toSorted((a, b) => a - b);
	const threadCpu = samples.flatMap((s) => s.threadCpu ?? []).toSorted((a, b) => a - b);
	const wall = samples.map((s) => s.wall).toSorted((a, b) => a - b);
	const site = siteCpu?.toSorted((a, b) => a - b);
	const ms = (value: number | undefined) =>
		value === undefined || Number.isNaN(value) ? "" : value.toPrecision(3);
	return {
		operation: name,
		samples: samples.length,
		"cpu p50 ms": ms(percentile(cpu, 50)),
		"cpu p95 ms": ms(percentile(cpu, 95)),
		"thread cpu p50 ms": ms(percentile(threadCpu, 50)),
		"thread cpu p95 ms": ms(percentile(threadCpu, 95)),
		"wall p50 ms": ms(percentile(wall, 50)),
		"wall p95 ms": ms(percentile(wall, 95)),
		"site cpu p50 ms": site ? ms(percentile(site, 50)) : "",
	};
}

describe.skipIf(!ENABLED)("room CPU time on the Node.js host", () => {
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;
	let registry: RoomRegistry;
	const timers = new ManualTimers();
	const socket = new ClientSocket();
	let room: string;
	let entryId: string;
	/** Each call the room made to the site, with the CPU it took, since the last sample. */
	let siteCalls: { call: keyof RoomSite; cpu: number }[] = [];
	const results: ReturnType<typeof summarize>[] = [];

	function timedSite(site: RoomSite): RoomSite {
		const timed =
			<A extends unknown[], R>(name: keyof RoomSite, call: (...args: A) => Promise<R>) =>
			async (...args: A): Promise<R> => {
				const start = process.cpuUsage();
				try {
					return await call(...args);
				} finally {
					siteCalls.push({ call: name, cpu: milliseconds(process.cpuUsage(start)) });
				}
			};
		return {
			load: timed("load", site.load.bind(site)),
			save: timed("save", site.save.bind(site)),
			saveRecovery: site.saveRecovery.bind(site),
		};
	}

	/**
	 * Runs an operation `WARMUP` times unmeasured, then `ITERATIONS` times measured, checking that
	 * each run made exactly the expected site calls and that no room work spilled outside a run.
	 */
	async function sampled(
		expectedCalls: (keyof RoomSite)[],
		prepare: (iteration: number) => Promise<void>,
		run: () => Promise<unknown>,
	): Promise<{ samples: Sample[]; site: number[] }> {
		const samples: Sample[] = [];
		const site: number[] = [];
		for (let i = 0; i < WARMUP + ITERATIONS; i++) {
			siteCalls = [];
			await prepare(i);
			const sample = await measure(run);
			expect(siteCalls.map(({ call }) => call)).toEqual(expectedCalls);
			if (i < WARMUP) continue;
			samples.push(sample);
			site.push(siteCalls.reduce((sum, { cpu }) => sum + cpu, 0));
		}
		return { samples, site };
	}

	beforeAll(async () => {
		db = await setupTestDatabase();
		const schema = new SchemaRegistry(db);
		await schema.createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts", "revisions"],
		});
		await schema.createField("post", { slug: "title", label: "Title", type: "string" });
		await schema.createField("post", { slug: "content", label: "Content", type: "portableText" });
		await db
			.insertInto("users")
			.values({
				id: EDITOR,
				email: "editor@example.com",
				name: "Editor",
				role: Role.EDITOR,
				email_verified: 1,
				disabled: 0,
			})
			.execute();
		runtime = createTestRuntime(db);
		registry = new RoomRegistry({
			db,
			site: timedSite(createRoomSite((fn) => runInFreshRequestContext(() => fn(runtime)))),
			build: BUILD,
			timers,
		});
		registry.activate();

		const item = await new ContentRepository(db).create({
			type: "post",
			data: { title: "A typical entry", content: typicalBody(WORDS) },
			slug: "typical",
			authorId: EDITOR,
		});
		entryId = item.id;
		room = roomId({ collection: "post", id: item.id });
		const { hash } = await runtime.getManifest();
		const issued = await registry.issueToken(room, {
			userId: EDITOR,
			name: "Editor",
			access: "edit",
			fingerprint: { ...BUILD, hash },
			rev: encodeRev(item),
			status: item.status,
			authorId: item.authorId,
		});
		if (typeof issued !== "object" || issued === null) throw new Error(`No token: ${issued}`);
		socket.accepted = registry.accept(room, issued.token, socket);
		socket.accepted?.receive(encodeSyncStep1(socket.doc));
		const body = socket.doc.getXmlFragment(fragmentName("content"));
		const deadline = Date.now() + 10_000;
		while (body.length === 0) {
			if (Date.now() > deadline) throw new Error("The client never received the document");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	});

	afterAll(async () => {
		if (results.length > 0) {
			console.log(
				`Room CPU time, ${ITERATIONS} samples after ${WARMUP} warmup runs, Node.js ${process.version}`,
			);
			console.table(results);
		}
		await registry?.shutdown();
		if (db) await teardownTestDatabase(db);
	});

	/** Applies an outside write without notifying the room, so only the room's response is timed. */
	async function writeOutside(data: Record<string, unknown>): Promise<void> {
		clearRoomNotifier(registry);
		try {
			const result = await runtime.handleContentUpdate("post", entryId, { data });
			if (!result.success) throw new Error(`Outside write failed: ${result.error.message}`);
		} finally {
			setRoomNotifier(registry);
		}
	}

	/** Notifies the room and waits for the merge it queues. */
	async function notifyAndMerge(): Promise<void> {
		const notified = registry.notify(room, []);
		// Without a hold, release waits for the merge the notification just queued.
		const merged = registry.release(room, "no-hold");
		await Promise.all([notified, merged]);
	}

	it("saves a 2,000-word entry after a small edit", async () => {
		const body = socket.doc.getXmlFragment(fragmentName("content"));
		let saved = 0;
		const { samples, site } = await sampled(
			["save"],
			async (i) => {
				const paragraph = body.get(1 + (i % 5));
				if (!(paragraph instanceof Y.XmlElement)) throw new Error("No paragraph to edit");
				const text = paragraph.get(0);
				if (!(text instanceof Y.XmlText)) throw new Error("No text to edit");
				text.insert(0, "a ");
			},
			async () => {
				const checkpoint = socket.nextCheckpoint();
				expect(timers.fire(SAVE_DELAY_MS)).toBe(1);
				await checkpoint;
				saved++;
			},
		);
		expect(saved).toBe(WARMUP + ITERATIONS);
		const draft = await new RevisionRepository(db).findLatest("post", entryId);
		expect(JSON.stringify(draft?.data)).toContain("a a a a a ");
		results.push(summarize("save after a small edit", samples, site));
	});

	it("merges an outside write to the title", async () => {
		const title = socket.doc.getMap("fields");
		const { samples, site } = await sampled(
			["load"],
			(i) => writeOutside({ title: `Outside title ${i}` }),
			notifyAndMerge,
		);
		expect(title.get("title")).toBe(`Outside title ${WARMUP + ITERATIONS - 1}`);
		results.push(summarize("merge an outside write to the title", samples, site));
	});

	it("merges an outside write to the 2,000-word body", async () => {
		const body = socket.doc.getXmlFragment(fragmentName("content"));
		const { samples, site } = await sampled(
			["load"],
			(i) => {
				const blocks = typicalBody(WORDS);
				blocks.push({
					_type: "block",
					_key: "outside",
					style: "normal",
					markDefs: [],
					children: [{ _type: "span", _key: "outside-span", text: `Outside ${i}`, marks: [] }],
				});
				return writeOutside({ content: blocks });
			},
			notifyAndMerge,
		);
		expect(body.toJSON()).toContain(`Outside ${WARMUP + ITERATIONS - 1}`);
		results.push(summarize("merge an outside write to the body", samples, site));
	});

	it("answers a notification for an open room with nothing to merge", async () => {
		const { samples, site } = await sampled(["load"], async () => {}, notifyAndMerge);
		results.push(summarize("notify an open room (nothing to merge)", samples, site));
	});

	it("answers a notification for a room that isn't open", async () => {
		const closed = roomId({ collection: "post", id: "01NOTOPEN" });
		const samples: Sample[] = [];
		for (let i = 0; i < WARMUP + ITERATIONS; i++) {
			const sample = await measure(async () => {
				for (let call = 0; call < BATCH; call++) await registry.notify(closed, []);
			}, BATCH);
			if (i >= WARMUP) samples.push(sample);
		}
		expect(registry.size).toBe(1);
		results.push(summarize(`notify a room that isn't open (mean of ${BATCH})`, samples));
	});
});
