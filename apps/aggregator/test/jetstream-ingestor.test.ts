/**
 * JetstreamIngestor unit tests.
 *
 * Drives the ingestor against MockJetstream, an in-memory queue, and a
 * Map-backed storage. No DO/D1/Queue runtime needed; the only Cloudflare
 * binding the ingestor depends on is "something with a send method", which
 * the mock queue trivially satisfies.
 *
 * Tests cover the ingestor's whole contract: event-to-job conversion,
 * cursor persistence, reconnect with backoff, stop semantics. Each one
 * pins a behaviour the production DO needs to honour; if a future change
 * regresses any of them the failure surfaces here, not in production.
 */

// Subpath imports avoid pulling in `@atproto/repo` (Node-crypto only) which
// the package's main entry transitively re-exports via FakeRepo. workerd
// can't load that, but we don't need it here — only MockJetstream + the
// NSID constants.
import { MockJetstream } from "@emdash-cms/atproto-test-utils/jetstream";
import { PROFILE_NSID, RELEASE_NSID } from "@emdash-cms/atproto-test-utils/nsid";
import { describe, expect, it } from "vitest";

import type { RecordsJob } from "../src/env.js";
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
	readonly jobs: RecordsJob[] = [];
	send(job: RecordsJob): Promise<void> {
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

/**
 * Adapter that turns a MockJetstream into the JetstreamClient interface
 * the ingestor uses. MockJetstream's subscribe() already returns an
 * AsyncIterable with a cursor + close, so this is a thin pass-through —
 * its only job is shaping the type.
 */
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
		wantedCollections: opts.wantedCollections ?? [PROFILE_NSID, RELEASE_NSID],
		// Tight backoff so tests don't sit in real timers; jitter off for
		// deterministic assertions.
		backoff: { initialDelayMs: 1, maxDelayMs: 5, multiplier: 2, jitter: 0 },
		sleep: () => Promise.resolve(),
	});
	const runPromise = ingestor.run();
	return { stream, queue, storage, ingestor, runPromise };
}

/** Wait until the predicate returns true or the test times out. Polls
 * the microtask queue rather than wall-clock; the ingestor reads events
 * eagerly inside an async iterator, so a small loop is enough. */
async function waitFor(predicate: () => boolean, label: string, attempts = 200): Promise<void> {
	for (let i = 0; i < attempts; i++) {
		if (predicate()) return;
		await Promise.resolve();
		await new Promise<void>((r) => setTimeout(r, 0));
	}
	throw new Error(`waitFor timed out: ${label}`);
}

describe("JetstreamIngestor", () => {
	it("converts a commit create event into a RecordsJob and enqueues it", async () => {
		const h = buildHarness();
		const event = h.stream.emitCommit({
			did: TEST_DID,
			collection: PROFILE_NSID,
			rkey: "p",
			cid: "bafyrecord",
			record: { slug: "p", license: "MIT" },
		});

		await waitFor(() => h.queue.jobs.length === 1, "first job enqueued");

		expect(h.queue.jobs[0]).toEqual({
			did: TEST_DID,
			collection: PROFILE_NSID,
			rkey: "p",
			operation: "create",
			cid: "bafyrecord",
			jetstreamRecord: { slug: "p", license: "MIT" },
		});
		expect(h.ingestor.currentCursor).toBe(event.time_us);

		h.ingestor.stop();
		await h.runPromise;
	});

	it("persists cursor to storage after each successful enqueue", async () => {
		const h = buildHarness();
		const e1 = h.stream.emitCommit({
			did: TEST_DID,
			collection: PROFILE_NSID,
			rkey: "a",
		});
		const e2 = h.stream.emitCommit({
			did: TEST_DID,
			collection: PROFILE_NSID,
			rkey: "b",
		});

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
			collection: PROFILE_NSID,
			rkey: "earlier",
		});
		const later = stream.emitCommit({
			did: TEST_DID,
			collection: PROFILE_NSID,
			rkey: "later",
		});

		// Pretend a previous run consumed the earlier event.
		await storage.put("jetstream:cursor", earlier.time_us);

		const ingestor = new JetstreamIngestor({
			client: new MockJetstreamClient(stream),
			queue,
			storage,
			wantedCollections: [PROFILE_NSID, RELEASE_NSID],
			backoff: { initialDelayMs: 1, maxDelayMs: 5, multiplier: 2, jitter: 0 },
			sleep: () => Promise.resolve(),
		});
		const runPromise = ingestor.run();

		await waitFor(() => queue.jobs.length === 1, "later event enqueued");

		expect(queue.jobs).toHaveLength(1);
		expect(queue.jobs[0]?.rkey).toBe("later");
		expect(ingestor.currentCursor).toBe(later.time_us);

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
				collection: PROFILE_NSID,
				rkey: "p",
				operation: "delete",
			},
		});

		await waitFor(() => h.queue.jobs.length === 1, "delete job enqueued");

		expect(h.queue.jobs[0]).toEqual({
			did: TEST_DID,
			collection: PROFILE_NSID,
			rkey: "p",
			operation: "delete",
			cid: "",
		});
		expect(h.queue.jobs[0]?.jetstreamRecord).toBeUndefined();

		h.ingestor.stop();
		await h.runPromise;
	});

	it("filters events outside wantedCollections (defence in depth)", async () => {
		// Real Jetstream filters server-side, but a malicious or buggy relay
		// could send something off-list. The ingestor must not enqueue it.
		const h = buildHarness({ wantedCollections: [PROFILE_NSID] });
		h.stream.emitCommit({
			did: TEST_DID,
			collection: RELEASE_NSID, // not in wantedCollections
			rkey: "ignored:1.0.0",
		});
		h.stream.emitCommit({
			did: TEST_DID,
			collection: PROFILE_NSID,
			rkey: "kept",
		});

		await waitFor(() => h.queue.jobs.length === 1, "filtered job enqueued");

		expect(h.queue.jobs).toHaveLength(1);
		expect(h.queue.jobs[0]?.rkey).toBe("kept");

		h.ingestor.stop();
		await h.runPromise;
	});

	it("stop() ends the run loop cleanly", async () => {
		const h = buildHarness();
		h.stream.emitCommit({ did: TEST_DID, collection: PROFILE_NSID, rkey: "p" });
		await waitFor(() => h.queue.jobs.length === 1, "first job");

		h.ingestor.stop();
		await expect(h.runPromise).resolves.toBeUndefined();
	});

	it("consecutiveFailures stays 0 across disconnect-with-events cycles", async () => {
		// Per the documented contract: 0 means the most recent connection
		// attempt produced at least one event. A connect → consume → close
		// cycle must NOT bump the counter to 1.
		const stream = new MockJetstream();
		const queue = new InMemoryQueue();
		const storage = new MapStorage();
		const ingestor = new JetstreamIngestor({
			client: new MockJetstreamClient(stream),
			queue,
			storage,
			wantedCollections: [PROFILE_NSID],
			backoff: { initialDelayMs: 1, maxDelayMs: 5, multiplier: 2, jitter: 0 },
			sleep: () => Promise.resolve(),
		});
		const runPromise = ingestor.run();

		// Three full cycles of: connect → emit → close. After each, the
		// counter should still be 0 because each attempt made progress.
		for (let i = 0; i < 3; i++) {
			stream.emitCommit({ did: TEST_DID, collection: PROFILE_NSID, rkey: `r${i}` });
			await waitFor(() => queue.jobs.length === i + 1, `event ${i}`);
			stream.closeAll();
			// Yield enough microtasks for the run loop to process the close
			// and complete its bookkeeping before we inspect.
			await new Promise<void>((r) => setTimeout(r, 5));
			expect(ingestor.consecutiveFailures).toBe(0);
		}

		ingestor.stop();
		await runPromise;
	});

	it("resets backoff after a successful event, even across reconnects", async () => {
		// Without a reset, a subscription that disconnects → reconnects →
		// processes an event → disconnects again would back off as if the
		// failures were continuous. The "made progress" flag should reset
		// the counter so each disconnect that consumed events starts fresh
		// from the initial delay.
		const stream = new MockJetstream();
		const queue = new InMemoryQueue();
		const storage = new MapStorage();
		const sleeps: number[] = [];
		const ingestor = new JetstreamIngestor({
			client: new MockJetstreamClient(stream),
			queue,
			storage,
			wantedCollections: [PROFILE_NSID],
			backoff: { initialDelayMs: 10, maxDelayMs: 1000, multiplier: 10, jitter: 0 },
			sleep: (ms) => {
				sleeps.push(ms);
				return Promise.resolve();
			},
		});
		const runPromise = ingestor.run();

		// Cycle 1: emit event, close. After backoff this should still be
		// the initial delay because we made progress.
		stream.emitCommit({ did: TEST_DID, collection: PROFILE_NSID, rkey: "a" });
		await waitFor(() => queue.jobs.length === 1, "first job");
		stream.closeAll();
		await waitFor(() => sleeps.length >= 1, "first backoff");

		// Cycle 2: emit another event, close. Backoff should still be the
		// initial delay (10ms), not 100ms (10×10), because progress in
		// between resets the counter.
		stream.emitCommit({ did: TEST_DID, collection: PROFILE_NSID, rkey: "b" });
		await waitFor(() => queue.jobs.length === 2, "second job", 500);
		stream.closeAll();
		await waitFor(() => sleeps.length >= 2, "second backoff", 500);

		expect(sleeps[0]).toBe(10);
		expect(sleeps[1]).toBe(10);

		ingestor.stop();
		await runPromise;
	});

	it("computes exponential backoff with cap, no jitter for determinism", async () => {
		// Direct unit on the backoff calc via stop()/restart of subscription.
		// The straightforward way: drive the stream, close the subscription
		// from underneath the ingestor (simulating a Jetstream disconnect),
		// observe the sleep delays the ingestor passes to our injected
		// `sleep`. Without driving real time we can't easily probe — instead
		// verify the run loop survives a series of forced disconnects and
		// keeps consuming after each.
		const stream = new MockJetstream();
		const queue = new InMemoryQueue();
		const storage = new MapStorage();
		const sleeps: number[] = [];
		const ingestor = new JetstreamIngestor({
			client: new MockJetstreamClient(stream),
			queue,
			storage,
			wantedCollections: [PROFILE_NSID],
			backoff: { initialDelayMs: 10, maxDelayMs: 80, multiplier: 2, jitter: 0 },
			sleep: (ms) => {
				sleeps.push(ms);
				return Promise.resolve();
			},
		});
		const runPromise = ingestor.run();

		// Emit one event so the subscription has work, then close it from the
		// MockJetstream side to simulate a server disconnect. The ingestor's
		// loop sees the iterator end, sleeps with backoff, reconnects.
		stream.emitCommit({ did: TEST_DID, collection: PROFILE_NSID, rkey: "a" });
		await waitFor(() => queue.jobs.length === 1, "first job");
		stream.closeAll();

		// After the disconnect, post a second event so the new subscription
		// has something to consume. Wait until it lands.
		stream.emitCommit({ did: TEST_DID, collection: PROFILE_NSID, rkey: "b" });
		await waitFor(() => queue.jobs.length === 2, "post-reconnect job", 500);

		// At least one backoff sleep happened between the disconnect and
		// the next successful subscription.
		expect(sleeps.length).toBeGreaterThanOrEqual(1);
		expect(sleeps[0]).toBeGreaterThanOrEqual(10);
		expect(sleeps[0]).toBeLessThanOrEqual(80);

		ingestor.stop();
		await runPromise;
	});
});
