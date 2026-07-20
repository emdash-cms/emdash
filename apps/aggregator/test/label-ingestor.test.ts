/**
 * LabelIngestor unit tests.
 *
 * Drives the ingestor against a fake `LabelStreamClient`, an in-memory queue,
 * a `Map`-backed cursor store, and a fake resolver — no DO/D1/Queue runtime
 * needed, mirroring `jetstream-ingestor.test.ts`'s injection style.
 *
 * The happy-path and verification-retry tests sign labels with a real P-256
 * keypair via `createLabelSigner` (`@emdash-cms/registry-moderation`), so
 * `verifyLabelWithPublicKey` runs for real rather than through a stub —
 * exactly the pipeline the labeler and the ingestor both use in production.
 */

import { P256PrivateKeyExportable } from "@atcute/crypto";
import { toBase64Url } from "@atcute/multibase";
import {
	createLabelSigner,
	type LabelSigner,
	type UnsignedLabel,
} from "@emdash-cms/registry-moderation";
import { describe, expect, it } from "vitest";

import { toWire, type LabelIngestJob } from "../src/label-ingest-types.js";
import {
	LabelIngestor,
	type LabelCursorStore,
	type LabelIngestorLogger,
	type LabelJobQueue,
	type LabelResolver,
} from "../src/label-ingestor.js";
import type {
	LabelStreamClient,
	LabelStreamEvent,
	LabelStreamSubscribeOptions,
} from "../src/label-stream-client.js";
import type { ResolvedLabelerIdentity } from "../src/labeler-resolver.js";

const LABELER_DID = "did:web:labeler.example";
const ENDPOINT = "https://labeler.example";

interface TestKey {
	signer: LabelSigner;
	identity: ResolvedLabelerIdentity;
}

/** Generates a real P-256 keypair, wraps it in a `createLabelSigner` whose
 * `resolveDid` is a closure returning a self-consistent DID document (no
 * network, no fixtures) and an `ResolvedLabelerIdentity` pointing at the same
 * key — everything the ingestor and `verifyLabelWithPublicKey` need. */
async function makeKey(issuerDid: string = LABELER_DID): Promise<TestKey> {
	const keypair = await P256PrivateKeyExportable.createKeypair();
	const privateKey = toBase64Url(await keypair.exportPrivateKey("raw"));
	const multikey = await keypair.exportPublicKey("multikey");
	const document = {
		id: issuerDid,
		verificationMethod: [
			{
				id: "#atproto_label",
				type: "Multikey",
				controller: issuerDid,
				publicKeyMultibase: multikey,
			},
		],
	};
	const signer = await createLabelSigner({
		issuerDid,
		privateKey,
		resolveDid: async () => document,
	});
	return {
		signer,
		identity: {
			endpoint: ENDPOINT,
			publicKey: keypair,
			signingKeyId: `${issuerDid}#atproto_label`,
		},
	};
}

function labelInput(uri: string): Omit<UnsignedLabel, "src"> {
	return { ver: 1, uri, val: "test-value", cts: "2026-07-10T12:00:00.000Z" };
}

class FakeHandle {
	closed = false;
	private queue: LabelStreamEvent[] = [];
	private pending: ((result: IteratorResult<LabelStreamEvent>) => void) | null = null;
	private ended = false;

	push(event: LabelStreamEvent): void {
		if (this.pending) {
			const resolve = this.pending;
			this.pending = null;
			resolve({ value: event, done: false });
			return;
		}
		this.queue.push(event);
	}

	endNormally(): void {
		if (this.ended) return;
		this.ended = true;
		if (this.pending) {
			const resolve = this.pending;
			this.pending = null;
			resolve({ value: undefined, done: true });
		}
	}

	close(): void {
		this.closed = true;
		this.endNormally();
	}

	[Symbol.asyncIterator](): AsyncIterator<LabelStreamEvent> {
		return {
			next: (): Promise<IteratorResult<LabelStreamEvent>> => {
				const item = this.queue.shift();
				if (item) return Promise.resolve({ value: item, done: false });
				if (this.ended) return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => {
					this.pending = resolve;
				});
			},
		};
	}
}

/** Fake transport. `emit`/`disconnect` act on the most recently subscribed
 * handle, mirroring `MockJetstream`'s driveable style. */
class FakeLabelStreamClient implements LabelStreamClient {
	readonly subscribeCalls: LabelStreamSubscribeOptions[] = [];
	private readonly handles: FakeHandle[] = [];

	subscribe(opts: LabelStreamSubscribeOptions): FakeHandle {
		this.subscribeCalls.push(opts);
		const handle = new FakeHandle();
		this.handles.push(handle);
		return handle;
	}

	private current(): FakeHandle {
		const handle = this.handles.at(-1);
		if (!handle) throw new Error("subscribe() has not been called yet");
		return handle;
	}

	emit(event: LabelStreamEvent): void {
		this.current().push(event);
	}

	/** Simulates a clean server-side disconnect uninvolved with verification
	 * — the ingestor should reconnect with backoff. */
	disconnect(): void {
		this.current().endNormally();
	}

	get closedHandleCount(): number {
		return this.handles.filter((h) => h.closed).length;
	}
}

class FakeLabelResolver implements LabelResolver {
	resolveCalls = 0;
	resolveFreshCalls = 0;
	current: ResolvedLabelerIdentity;
	/** What `resolveFresh` returns. Defaults to `current`; tests override to
	 * simulate a key rotation (or a still-wrong key, for the persistent-failure
	 * path). */
	fresh: ResolvedLabelerIdentity;

	constructor(identity: ResolvedLabelerIdentity) {
		this.current = identity;
		this.fresh = identity;
	}

	resolve(): Promise<ResolvedLabelerIdentity> {
		this.resolveCalls += 1;
		return Promise.resolve(this.current);
	}

	resolveFresh(): Promise<ResolvedLabelerIdentity> {
		this.resolveFreshCalls += 1;
		return Promise.resolve(this.fresh);
	}
}

class InMemoryQueue implements LabelJobQueue {
	readonly jobs: LabelIngestJob[] = [];
	send(job: LabelIngestJob): Promise<void> {
		this.jobs.push(job);
		return Promise.resolve();
	}
}

class MapCursorStore implements LabelCursorStore {
	private cursor: number | undefined;
	readonly puts: number[] = [];
	constructor(initial?: number) {
		this.cursor = initial;
	}
	get(): Promise<number | undefined> {
		return Promise.resolve(this.cursor);
	}
	put(cursor: number): Promise<void> {
		this.cursor = cursor;
		this.puts.push(cursor);
		return Promise.resolve();
	}
}

/** Records send-resolution and cursor-put order into one shared log so
 * ordering assertions don't depend on wall-clock timing. */
class DeferredQueue implements LabelJobQueue {
	readonly jobs: LabelIngestJob[] = [];
	private readonly resolvers: Array<() => void> = [];
	constructor(private readonly log: string[]) {}

	send(job: LabelIngestJob): Promise<void> {
		this.jobs.push(job);
		return new Promise<void>((resolve) => {
			this.resolvers.push(() => {
				this.log.push(`send-resolved:${job.frameIndex}`);
				resolve();
			});
		});
	}

	resolveNext(): void {
		const next = this.resolvers.shift();
		if (!next) throw new Error("no pending send to resolve");
		next();
	}
}

class LoggingCursorStore implements LabelCursorStore {
	private cursor: number | undefined;
	constructor(private readonly log: string[]) {}
	get(): Promise<number | undefined> {
		return Promise.resolve(this.cursor);
	}
	put(cursor: number): Promise<void> {
		this.log.push(`cursor-put:${cursor}`);
		this.cursor = cursor;
		return Promise.resolve();
	}
}

const TIGHT_BACKOFF = { initialDelayMs: 1, maxDelayMs: 5, multiplier: 2, jitter: 0 };

/** Wait until the predicate returns true or the test times out. Polls the
 * microtask + macrotask queue rather than wall-clock. */
async function waitFor(predicate: () => boolean, label: string, attempts = 200): Promise<void> {
	for (let i = 0; i < attempts; i++) {
		if (predicate()) return;
		await Promise.resolve();
		await new Promise<void>((r) => setTimeout(r, 0));
	}
	throw new Error(`waitFor timed out: ${label}`);
}

describe("LabelIngestor", () => {
	it("verifies a real signed label and enqueues it, advancing the cursor", async () => {
		const key = await makeKey();
		const client = new FakeLabelStreamClient();
		const queue = new InMemoryQueue();
		const cursorStore = new MapCursorStore();
		const resolver = new FakeLabelResolver(key.identity);
		const ingestor = new LabelIngestor({
			did: LABELER_DID,
			client,
			queue,
			cursorStore,
			resolver,
			backoff: TIGHT_BACKOFF,
			sleep: () => Promise.resolve(),
		});
		const runPromise = ingestor.run();

		const signed = await key.signer.sign(labelInput("at://did:example:pub/x/1"));
		client.emit({ seq: 1, labels: [signed] });

		await waitFor(() => queue.jobs.length === 1, "label enqueued");
		expect(queue.jobs[0]).toEqual({
			src: LABELER_DID,
			sourceSequence: 1,
			frameIndex: 0,
			label: toWire(signed),
		});
		expect(ingestor.currentCursor).toBe(1);
		await waitFor(() => cursorStore.puts.includes(1), "cursor persisted");

		ingestor.stop();
		await runPromise;
	});

	it("enqueues every label in a multi-label frame with the correct frameIndex", async () => {
		const key = await makeKey();
		const client = new FakeLabelStreamClient();
		const queue = new InMemoryQueue();
		const resolver = new FakeLabelResolver(key.identity);
		const ingestor = new LabelIngestor({
			did: LABELER_DID,
			client,
			queue,
			cursorStore: new MapCursorStore(),
			resolver,
			backoff: TIGHT_BACKOFF,
			sleep: () => Promise.resolve(),
		});
		const runPromise = ingestor.run();

		const a = await key.signer.sign(labelInput("at://did:example:pub/a/1"));
		const b = await key.signer.sign(labelInput("at://did:example:pub/b/1"));
		client.emit({ seq: 7, labels: [a, b] });

		await waitFor(() => queue.jobs.length === 2, "both labels enqueued");
		expect(queue.jobs[0]?.frameIndex).toBe(0);
		expect(queue.jobs[1]?.frameIndex).toBe(1);
		expect(queue.jobs[0]?.sourceSequence).toBe(7);
		expect(queue.jobs[1]?.sourceSequence).toBe(7);

		ingestor.stop();
		await runPromise;
	});

	it("subscribes with cursor 0 when no cursor is persisted", async () => {
		const key = await makeKey();
		const client = new FakeLabelStreamClient();
		const ingestor = new LabelIngestor({
			did: LABELER_DID,
			client,
			queue: new InMemoryQueue(),
			cursorStore: new MapCursorStore(),
			resolver: new FakeLabelResolver(key.identity),
			backoff: TIGHT_BACKOFF,
			sleep: () => Promise.resolve(),
		});
		const runPromise = ingestor.run();

		await waitFor(() => client.subscribeCalls.length === 1, "subscribed");
		expect(client.subscribeCalls[0]).toEqual({ endpoint: ENDPOINT, cursor: 0 });

		ingestor.stop();
		await runPromise;
	});

	it("subscribes with the persisted cursor when one exists", async () => {
		const key = await makeKey();
		const client = new FakeLabelStreamClient();
		const ingestor = new LabelIngestor({
			did: LABELER_DID,
			client,
			queue: new InMemoryQueue(),
			cursorStore: new MapCursorStore(42),
			resolver: new FakeLabelResolver(key.identity),
			backoff: TIGHT_BACKOFF,
			sleep: () => Promise.resolve(),
		});
		const runPromise = ingestor.run();

		await waitFor(() => client.subscribeCalls.length === 1, "subscribed");
		expect(client.subscribeCalls[0]).toEqual({ endpoint: ENDPOINT, cursor: 42 });

		ingestor.stop();
		await runPromise;
	});

	it("retries a failed initial cursor load instead of dying at cold start", async () => {
		const key = await makeKey();
		const client = new FakeLabelStreamClient();
		const store = new MapCursorStore(42);
		let getCalls = 0;
		const flakyStore: LabelCursorStore = {
			get(): Promise<number | undefined> {
				getCalls += 1;
				if (getCalls === 1) return Promise.reject(new Error("transient D1 failure"));
				return store.get();
			},
			put: (cursor) => store.put(cursor),
		};
		const ingestor = new LabelIngestor({
			did: LABELER_DID,
			client,
			queue: new InMemoryQueue(),
			cursorStore: flakyStore,
			resolver: new FakeLabelResolver(key.identity),
			backoff: TIGHT_BACKOFF,
			sleep: () => Promise.resolve(),
		});
		const runPromise = ingestor.run();

		await waitFor(() => client.subscribeCalls.length === 1, "subscribed after cursor retry");
		expect(getCalls).toBe(2);
		expect(client.subscribeCalls[0]).toEqual({ endpoint: ENDPOINT, cursor: 42 });

		ingestor.stop();
		await runPromise;
	});

	it("retries once via resolveFresh after a verification failure, then enqueues", async () => {
		const staleKey = await makeKey();
		const rotatedKey = await makeKey();
		const client = new FakeLabelStreamClient();
		const queue = new InMemoryQueue();
		const cursorStore = new MapCursorStore();
		const resolver = new FakeLabelResolver(staleKey.identity);
		resolver.fresh = rotatedKey.identity;
		const ingestor = new LabelIngestor({
			did: LABELER_DID,
			client,
			queue,
			cursorStore,
			resolver,
			backoff: TIGHT_BACKOFF,
			sleep: () => Promise.resolve(),
		});
		const runPromise = ingestor.run();

		// Signed with the rotated key, but the resolver's cache still points
		// at the stale one — first verification attempt must fail.
		const signed = await rotatedKey.signer.sign(labelInput("at://did:example:pub/x/1"));
		client.emit({ seq: 5, labels: [signed] });

		await waitFor(() => queue.jobs.length === 1, "label enqueued after retry");
		expect(resolver.resolveFreshCalls).toBe(1);
		expect(ingestor.currentCursor).toBe(5);

		ingestor.stop();
		await runPromise;
	});

	it("closes the connection on a second verification failure, enqueueing nothing and leaving the cursor unchanged", async () => {
		const configuredKey = await makeKey();
		const unknownKey = await makeKey();
		const client = new FakeLabelStreamClient();
		const queue = new InMemoryQueue();
		const cursorStore = new MapCursorStore();
		const resolver = new FakeLabelResolver(configuredKey.identity);
		// The refresh doesn't help — still the wrong key.
		resolver.fresh = configuredKey.identity;
		const logger: LabelIngestorLogger = { error: () => {}, warn: () => {} };
		const ingestor = new LabelIngestor({
			did: LABELER_DID,
			client,
			queue,
			cursorStore,
			resolver,
			logger,
			backoff: TIGHT_BACKOFF,
			sleep: () => Promise.resolve(),
		});
		const runPromise = ingestor.run();

		const signed = await unknownKey.signer.sign(labelInput("at://did:example:pub/x/1"));
		client.emit({ seq: 9, labels: [signed] });

		await waitFor(() => ingestor.consecutiveFailures >= 1, "failure counted");
		expect(queue.jobs).toHaveLength(0);
		expect(ingestor.currentCursor).toBe(0);
		expect(resolver.resolveFreshCalls).toBe(1);
		expect(client.closedHandleCount).toBeGreaterThanOrEqual(1);

		ingestor.stop();
		await runPromise;
	});

	it("treats a src mismatch as a verification failure", async () => {
		const configuredKey = await makeKey(LABELER_DID);
		const otherIssuer = await makeKey("did:web:other.example");
		const client = new FakeLabelStreamClient();
		const queue = new InMemoryQueue();
		const resolver = new FakeLabelResolver(configuredKey.identity);
		const ingestor = new LabelIngestor({
			did: LABELER_DID,
			client,
			queue,
			cursorStore: new MapCursorStore(),
			resolver,
			backoff: TIGHT_BACKOFF,
			sleep: () => Promise.resolve(),
		});
		const runPromise = ingestor.run();

		// Validly signed by its own issuer, but that issuer isn't the DID this
		// ingestor is configured for.
		const signed = await otherIssuer.signer.sign(labelInput("at://did:example:pub/x/1"));
		client.emit({ seq: 3, labels: [signed] });

		await waitFor(() => ingestor.consecutiveFailures >= 1, "failure counted");
		expect(queue.jobs).toHaveLength(0);
		expect(ingestor.currentCursor).toBe(0);

		ingestor.stop();
		await runPromise;
	});

	it("fails closed on a malformed label (parseSignedLabel throws)", async () => {
		const key = await makeKey();
		const client = new FakeLabelStreamClient();
		const queue = new InMemoryQueue();
		const resolver = new FakeLabelResolver(key.identity);
		const ingestor = new LabelIngestor({
			did: LABELER_DID,
			client,
			queue,
			cursorStore: new MapCursorStore(),
			resolver,
			backoff: TIGHT_BACKOFF,
			sleep: () => Promise.resolve(),
		});
		const runPromise = ingestor.run();

		await waitFor(() => client.subscribeCalls.length === 1, "subscribed");
		client.emit({ seq: 4, labels: [{ not: "a valid label" }] });

		await waitFor(() => ingestor.consecutiveFailures >= 1, "failure counted");
		expect(queue.jobs).toHaveLength(0);
		expect(ingestor.currentCursor).toBe(0);

		ingestor.stop();
		await runPromise;
	});

	it("fails closed on a tampered signature", async () => {
		const key = await makeKey();
		const client = new FakeLabelStreamClient();
		const queue = new InMemoryQueue();
		const resolver = new FakeLabelResolver(key.identity);
		const ingestor = new LabelIngestor({
			did: LABELER_DID,
			client,
			queue,
			cursorStore: new MapCursorStore(),
			resolver,
			backoff: TIGHT_BACKOFF,
			sleep: () => Promise.resolve(),
		});
		const runPromise = ingestor.run();

		const signed = await key.signer.sign(labelInput("at://did:example:pub/x/1"));
		const tampered = { ...signed, sig: signed.sig.map((b, i) => (i === 0 ? b ^ 0xff : b)) };
		client.emit({ seq: 6, labels: [tampered] });

		await waitFor(() => ingestor.consecutiveFailures >= 1, "failure counted");
		expect(queue.jobs).toHaveLength(0);

		ingestor.stop();
		await runPromise;
	});

	it("counts a failure when a connection ends on a verification failure after earlier progress", async () => {
		const key = await makeKey();
		const wrongKey = await makeKey();
		const client = new FakeLabelStreamClient();
		const queue = new InMemoryQueue();
		const ingestor = new LabelIngestor({
			did: LABELER_DID,
			client,
			queue,
			cursorStore: new MapCursorStore(),
			resolver: new FakeLabelResolver(key.identity),
			backoff: TIGHT_BACKOFF,
			sleep: () => Promise.resolve(),
		});
		const runPromise = ingestor.run();

		const good = await key.signer.sign(labelInput("at://did:example:pub/x/1"));
		client.emit({ seq: 1, labels: [good] });
		await waitFor(() => queue.jobs.length === 1, "good frame enqueued");

		// Same connection: a frame that cannot verify. The good frame must not
		// count as progress that resets the backoff counter.
		const bad = await wrongKey.signer.sign(labelInput("at://did:example:pub/x/2"));
		client.emit({ seq: 2, labels: [bad] });
		await waitFor(
			() => ingestor.consecutiveFailures >= 1,
			"failure counted despite earlier progress",
		);
		expect(queue.jobs).toHaveLength(1);
		expect(ingestor.currentCursor).toBe(1);

		ingestor.stop();
		await runPromise;
	});

	it("persists the cursor only after every send in the frame resolves", async () => {
		const key = await makeKey();
		const client = new FakeLabelStreamClient();
		const log: string[] = [];
		const queue = new DeferredQueue(log);
		const cursorStore = new LoggingCursorStore(log);
		const resolver = new FakeLabelResolver(key.identity);
		const ingestor = new LabelIngestor({
			did: LABELER_DID,
			client,
			queue,
			cursorStore,
			resolver,
			backoff: TIGHT_BACKOFF,
			sleep: () => Promise.resolve(),
		});
		const runPromise = ingestor.run();

		const a = await key.signer.sign(labelInput("at://did:example:pub/a/1"));
		const b = await key.signer.sign(labelInput("at://did:example:pub/b/1"));
		client.emit({ seq: 3, labels: [a, b] });

		await waitFor(() => queue.jobs.length === 1, "first send started");
		expect(log).toEqual([]);

		queue.resolveNext();
		await waitFor(() => queue.jobs.length === 2, "second send started");
		expect(log).toEqual(["send-resolved:0"]);

		queue.resolveNext();
		await waitFor(() => log.includes("cursor-put:3"), "cursor persisted");
		expect(log).toEqual(["send-resolved:0", "send-resolved:1", "cursor-put:3"]);

		ingestor.stop();
		await runPromise;
	});

	it("does not persist the cursor when a queue.send call rejects", async () => {
		const key = await makeKey();
		const client = new FakeLabelStreamClient();
		const cursorStore = new MapCursorStore();
		const queue: LabelJobQueue = {
			send: () => Promise.reject(new Error("queue unavailable")),
		};
		const resolver = new FakeLabelResolver(key.identity);
		const ingestor = new LabelIngestor({
			did: LABELER_DID,
			client,
			queue,
			cursorStore,
			resolver,
			backoff: TIGHT_BACKOFF,
			sleep: () => Promise.resolve(),
		});
		const runPromise = ingestor.run();

		const signed = await key.signer.sign(labelInput("at://did:example:pub/x/1"));
		client.emit({ seq: 1, labels: [signed] });

		await waitFor(() => ingestor.consecutiveFailures >= 1, "failure counted after send rejection");
		expect(cursorStore.puts).toHaveLength(0);
		expect(ingestor.currentCursor).toBe(0);

		ingestor.stop();
		await runPromise;
	});

	it("resets backoff after a frame is fully processed, even across reconnects", async () => {
		const key = await makeKey();
		const client = new FakeLabelStreamClient();
		const queue = new InMemoryQueue();
		const resolver = new FakeLabelResolver(key.identity);
		const sleeps: number[] = [];
		const ingestor = new LabelIngestor({
			did: LABELER_DID,
			client,
			queue,
			cursorStore: new MapCursorStore(),
			resolver,
			backoff: { initialDelayMs: 10, maxDelayMs: 1000, multiplier: 10, jitter: 0 },
			sleep: (ms) => {
				sleeps.push(ms);
				return Promise.resolve();
			},
		});
		const runPromise = ingestor.run();

		const a = await key.signer.sign(labelInput("at://did:example:pub/a/1"));
		client.emit({ seq: 1, labels: [a] });
		await waitFor(() => queue.jobs.length === 1, "first job");
		client.disconnect();
		await waitFor(() => sleeps.length >= 1, "first backoff");
		await waitFor(() => client.subscribeCalls.length === 2, "reconnected");

		const b = await key.signer.sign(labelInput("at://did:example:pub/b/1"));
		client.emit({ seq: 2, labels: [b] });
		await waitFor(() => queue.jobs.length === 2, "second job", 500);
		client.disconnect();
		await waitFor(() => sleeps.length >= 2, "second backoff", 500);

		// Both backoffs are the initial delay (10ms), not 100ms (10×10) —
		// progress in between resets the counter each time.
		expect(sleeps[0]).toBe(10);
		expect(sleeps[1]).toBe(10);

		ingestor.stop();
		await runPromise;
	});

	it("escalates backoff across repeated verification failures and resets once one succeeds", async () => {
		const configuredKey = await makeKey();
		const unknownKey = await makeKey();
		const client = new FakeLabelStreamClient();
		const queue = new InMemoryQueue();
		// The refresh never helps — every attempt is signed by a key the
		// resolver never returns, so every connection attempt fails.
		const resolver = new FakeLabelResolver(configuredKey.identity);
		const sleeps: number[] = [];
		const ingestor = new LabelIngestor({
			did: LABELER_DID,
			client,
			queue,
			cursorStore: new MapCursorStore(),
			resolver,
			backoff: { initialDelayMs: 10, maxDelayMs: 80, multiplier: 2, jitter: 0 },
			sleep: (ms) => {
				sleeps.push(ms);
				return Promise.resolve();
			},
		});
		const runPromise = ingestor.run();

		for (let i = 0; i < 2; i++) {
			await waitFor(() => client.subscribeCalls.length === i + 1, `attempt ${i} connected`);
			const signed = await unknownKey.signer.sign(labelInput(`at://did:example:pub/x/${i}`));
			client.emit({ seq: i + 1, labels: [signed] });
			await waitFor(() => sleeps.length === i + 1, `backoff ${i}`);
		}
		expect(sleeps[0]).toBe(10);
		expect(sleeps[1]).toBe(20);

		// Now let the same connection succeed with the correctly configured key.
		await waitFor(() => client.subscribeCalls.length === 3, "third attempt connected");
		const good = await configuredKey.signer.sign(labelInput("at://did:example:pub/good/1"));
		client.emit({ seq: 100, labels: [good] });
		await waitFor(() => queue.jobs.length === 1, "succeeded after escalation");
		// consecutiveFailures resets only once connectAndConsume() returns, which
		// requires the subscription to end — disconnect to observe the reset.
		client.disconnect();
		await waitFor(() => ingestor.consecutiveFailures === 0, "backoff reset after progress");

		ingestor.stop();
		await runPromise;
	});
});
