/**
 * JetstreamIngestor unit tests. Adapted from
 * apps/aggregator/test/jetstream-ingestor.test.ts — the ingestor logic is a
 * near-verbatim copy (decision: copy, don't extract), so the same
 * behavioural contract applies: event-to-job conversion, cursor
 * persistence, reconnect with backoff, stop semantics.
 */

import { MockJetstream } from "@emdash-cms/atproto-test-utils/jetstream";
import { RELEASE_NSID } from "@emdash-cms/atproto-test-utils/nsid";
import { describe, expect, it } from "vitest";

import type { DiscoveryJob } from "../src/env.js";
import type {
	JetstreamClient,
	JetstreamSubscribeOptions,
	JetstreamSubscriptionHandle,
} from "../src/jetstream-client.js";
import {
	JetstreamIngestor,
	type IngestorStorage,
	type JobQueue,
} from "../src/jetstream-ingestor.js";

const TEST_DID = "did:plc:test00000000000000000000";

class InMemoryQueue implements JobQueue {
	readonly jobs: DiscoveryJob[] = [];
	send(job: DiscoveryJob): Promise<void> {
		this.jobs.push(job);
		return Promise.resolve();
	}
}

class MapStorage implements IngestorStorage {
	private readonly map = new Map<string, number>();
	get(key: string): Promise<number | undefined> {
		return Promise.resolve(this.map.get(key));
	}
	put(key: string, value: number): Promise<void> {
		this.map.set(key, value);
		return Promise.resolve();
	}
}

class MockJetstreamClient implements JetstreamClient {
	constructor(private readonly stream: MockJetstream) {}
	subscribe(opts: JetstreamSubscribeOptions): JetstreamSubscriptionHandle {
		return this.stream.subscribe({
			wantedCollections: [...opts.wantedCollections],
			...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
		});
	}
}

interface Harness {
	stream: MockJetstream;
	queue: InMemoryQueue;
	storage: MapStorage;
	ingestor: JetstreamIngestor;
	runPromise: Promise<void>;
}

function buildHarness(opts: { wantedCollections?: readonly string[] } = {}): Harness {
	const stream = new MockJetstream();
	const queue = new InMemoryQueue();
	const storage = new MapStorage();
	const ingestor = new JetstreamIngestor({
		client: new MockJetstreamClient(stream),
		queue,
		storage,
		wantedCollections: opts.wantedCollections ?? [RELEASE_NSID],
		backoff: { initialDelayMs: 1, maxDelayMs: 5, multiplier: 2, jitter: 0 },
		sleep: () => Promise.resolve(),
	});
	const runPromise = ingestor.run();
	return { stream, queue, storage, ingestor, runPromise };
}

async function waitFor(predicate: () => boolean, label: string, attempts = 200): Promise<void> {
	for (let i = 0; i < attempts; i++) {
		if (predicate()) return;
		await Promise.resolve();
		await new Promise<void>((r) => setTimeout(r, 0));
	}
	throw new Error(`waitFor timed out: ${label}`);
}

describe("JetstreamIngestor (labeler discovery)", () => {
	it("converts a commit create event into a DiscoveryJob and enqueues it", async () => {
		const h = buildHarness();
		const event = h.stream.emitCommit({
			did: TEST_DID,
			collection: RELEASE_NSID,
			rkey: "demo:1.0.0",
			cid: "bafyrecord",
			record: { package: "demo", version: "1.0.0" },
		});

		await waitFor(() => h.queue.jobs.length === 1, "first job enqueued");

		expect(h.queue.jobs[0]).toEqual({
			did: TEST_DID,
			collection: RELEASE_NSID,
			rkey: "demo:1.0.0",
			operation: "create",
			cid: "bafyrecord",
			jetstreamRecord: { package: "demo", version: "1.0.0" },
		});
		expect(h.ingestor.currentCursor).toBe(event.time_us);

		h.ingestor.stop();
		await h.runPromise;
	});

	it("persists cursor to storage after each successful enqueue", async () => {
		const h = buildHarness();
		const e1 = h.stream.emitCommit({ did: TEST_DID, collection: RELEASE_NSID, rkey: "a:1.0.0" });
		const e2 = h.stream.emitCommit({ did: TEST_DID, collection: RELEASE_NSID, rkey: "b:1.0.0" });

		await waitFor(() => h.queue.jobs.length === 2, "both jobs enqueued");

		expect(await h.storage.get("jetstream:cursor")).toBe(e2.time_us);
		expect(e2.time_us).toBeGreaterThan(e1.time_us);

		h.ingestor.stop();
		await h.runPromise;
	});

	it("resumes from the persisted cursor on a fresh ingestor", async () => {
		const stream = new MockJetstream();
		const queue = new InMemoryQueue();
		const storage = new MapStorage();
		const earlier = stream.emitCommit({
			did: TEST_DID,
			collection: RELEASE_NSID,
			rkey: "earlier:1.0.0",
		});
		const later = stream.emitCommit({
			did: TEST_DID,
			collection: RELEASE_NSID,
			rkey: "later:1.0.0",
		});

		await storage.put("jetstream:cursor", earlier.time_us);

		const ingestor = new JetstreamIngestor({
			client: new MockJetstreamClient(stream),
			queue,
			storage,
			wantedCollections: [RELEASE_NSID],
			backoff: { initialDelayMs: 1, maxDelayMs: 5, multiplier: 2, jitter: 0 },
			sleep: () => Promise.resolve(),
		});
		const runPromise = ingestor.run();

		await waitFor(() => queue.jobs.length === 1, "later event enqueued");

		expect(queue.jobs).toHaveLength(1);
		expect(queue.jobs[0]?.rkey).toBe("later:1.0.0");
		expect(ingestor.currentCursor).toBe(later.time_us);

		ingestor.stop();
		await runPromise;
	});

	it("falls back to subscription default when storage is empty (no cursorFloor)", async () => {
		// Unlike the aggregator, the labeler has no backfill concept — a fresh
		// deploy assesses releases going forward from "now", never deriving a
		// floor. Production wiring doesn't pass `cursorFloor` at all.
		const stream = new MockJetstream();
		const queue = new InMemoryQueue();
		const storage = new MapStorage();

		const ingestor = new JetstreamIngestor({
			client: new MockJetstreamClient(stream),
			queue,
			storage,
			wantedCollections: [RELEASE_NSID],
			backoff: { initialDelayMs: 1, maxDelayMs: 5, multiplier: 2, jitter: 0 },
			sleep: () => Promise.resolve(),
		});
		const runPromise = ingestor.run();
		await new Promise((resolve) => setTimeout(resolve, 5));

		expect(ingestor.currentCursor).toBeNull();
		expect(await storage.get("jetstream:cursor")).toBeUndefined();

		ingestor.stop();
		await runPromise;
	});

	it("handles delete operations (no record body, empty cid)", async () => {
		const h = buildHarness();
		h.stream.emit({
			did: TEST_DID,
			time_us: Date.now() * 1000,
			kind: "commit",
			commit: {
				rev: "rev-del",
				collection: RELEASE_NSID,
				rkey: "demo:1.0.0",
				operation: "delete",
			},
		});

		await waitFor(() => h.queue.jobs.length === 1, "delete job enqueued");

		expect(h.queue.jobs[0]).toEqual({
			did: TEST_DID,
			collection: RELEASE_NSID,
			rkey: "demo:1.0.0",
			operation: "delete",
			cid: "",
		});
		expect(h.queue.jobs[0]?.jetstreamRecord).toBeUndefined();

		h.ingestor.stop();
		await h.runPromise;
	});

	it("filters events outside wantedCollections (defence in depth)", async () => {
		const h = buildHarness({ wantedCollections: [RELEASE_NSID] });
		h.stream.emitCommit({
			did: TEST_DID,
			collection: "com.emdashcms.experimental.package.profile", // not in wantedCollections
			rkey: "ignored",
		});
		h.stream.emitCommit({ did: TEST_DID, collection: RELEASE_NSID, rkey: "kept:1.0.0" });

		await waitFor(() => h.queue.jobs.length === 1, "filtered job enqueued");

		expect(h.queue.jobs).toHaveLength(1);
		expect(h.queue.jobs[0]?.rkey).toBe("kept:1.0.0");

		h.ingestor.stop();
		await h.runPromise;
	});

	it("stop() ends the run loop cleanly", async () => {
		const h = buildHarness();
		h.stream.emitCommit({ did: TEST_DID, collection: RELEASE_NSID, rkey: "p:1.0.0" });
		await waitFor(() => h.queue.jobs.length === 1, "first job");

		h.ingestor.stop();
		await expect(h.runPromise).resolves.toBeUndefined();
	});

	it("resets backoff after a successful event, even across reconnects", async () => {
		const stream = new MockJetstream();
		const queue = new InMemoryQueue();
		const storage = new MapStorage();
		const sleeps: number[] = [];
		const ingestor = new JetstreamIngestor({
			client: new MockJetstreamClient(stream),
			queue,
			storage,
			wantedCollections: [RELEASE_NSID],
			backoff: { initialDelayMs: 10, maxDelayMs: 1000, multiplier: 10, jitter: 0 },
			sleep: (ms) => {
				sleeps.push(ms);
				return Promise.resolve();
			},
		});
		const runPromise = ingestor.run();

		stream.emitCommit({ did: TEST_DID, collection: RELEASE_NSID, rkey: "a:1.0.0" });
		await waitFor(() => queue.jobs.length === 1, "first job");
		stream.closeAll();
		await waitFor(() => sleeps.length >= 1, "first backoff");

		stream.emitCommit({ did: TEST_DID, collection: RELEASE_NSID, rkey: "b:1.0.0" });
		await waitFor(() => queue.jobs.length === 2, "second job", 500);
		stream.closeAll();
		await waitFor(() => sleeps.length >= 2, "second backoff", 500);

		expect(sleeps[0]).toBe(10);
		expect(sleeps[1]).toBe(10);

		ingestor.stop();
		await runPromise;
	});
});
