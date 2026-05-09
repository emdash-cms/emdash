/**
 * Jetstream ingestor. Subscribes to a Jetstream client, converts commit
 * events into `RecordsJob` messages, enqueues them, and persists the
 * cursor so reconnects resume cleanly.
 *
 * Owns:
 *   - Connection lifecycle (connect → consume → disconnect → backoff →
 *     reconnect, indefinitely until `stop()` is called).
 *   - Cursor persistence after each successful enqueue. Persisting AFTER
 *     enqueue means a crash can replay the most recent event; downstream
 *     ingest is idempotent (DO NOTHING on duplicate releases) so this is
 *     safe and strictly better than the alternative of skipping events.
 *   - Exponential backoff with jitter, capped, reset on each successful
 *     event.
 *
 * Pure constructor injection — no DO/D1/Queue infrastructure imports — so
 * unit tests instantiate it directly with `MockJetstream` + an in-memory
 * queue + a `Map`-backed storage.
 */

import { WANTED_COLLECTIONS } from "./constants.js";
import type { RecordsJob } from "./env.js";
import type {
	JetstreamClient,
	JetstreamCommitEvent,
	JetstreamSubscriptionHandle,
} from "./jetstream-client.js";

const CURSOR_STORAGE_KEY = "jetstream:cursor";

/**
 * Subset of `Queue.send` we use. Return type is loose because workerd's
 * `Queue.send` resolves to `QueueSendResponse` while a hand-rolled
 * in-memory test queue resolves to `void` — neither piece of metadata
 * matters to the ingestor.
 */
export interface JobQueue {
	send(job: RecordsJob): Promise<unknown>;
}

/** Subset of DurableObjectStorage we use. Tests pass a Map-backed shim. */
export interface IngestorStorage {
	get(key: string): Promise<number | undefined>;
	put(key: string, value: number): Promise<void>;
}

export interface IngestorBackoffConfig {
	/** Initial delay after the first disconnect (ms). Default 1s. */
	initialDelayMs?: number;
	/** Cap (ms). Default 60s. */
	maxDelayMs?: number;
	/** Multiplier per retry. Default 2. */
	multiplier?: number;
	/** ±jitter as a fraction of the delay. Default 0.2 (±20%). 0 disables. */
	jitter?: number;
}

export interface IngestorLogger {
	info?(msg: string, ctx?: Record<string, unknown>): void;
	warn?(msg: string, ctx?: Record<string, unknown>): void;
	error?(msg: string, ctx?: Record<string, unknown>): void;
}

export interface JetstreamIngestorOptions {
	client: JetstreamClient;
	queue: JobQueue;
	storage: IngestorStorage;
	/** Defaults to the protocol-level WANTED_COLLECTIONS constant. */
	wantedCollections?: readonly string[];
	backoff?: IngestorBackoffConfig;
	logger?: IngestorLogger;
	/** Sleep impl, swap in tests to skip real backoff waits. */
	sleep?: (ms: number) => Promise<void>;
	/** Random source for jitter, swap in tests for determinism. */
	random?: () => number;
}

const DEFAULT_BACKOFF: Required<IngestorBackoffConfig> = {
	initialDelayMs: 1_000,
	maxDelayMs: 60_000,
	multiplier: 2,
	jitter: 0.2,
};

export class JetstreamIngestor {
	private readonly client: JetstreamClient;
	private readonly queue: JobQueue;
	private readonly storage: IngestorStorage;
	private readonly wantedCollections: readonly string[];
	private readonly backoff: Required<IngestorBackoffConfig>;
	private readonly logger: IngestorLogger;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly random: () => number;

	private stopped = false;
	private currentSub: JetstreamSubscriptionHandle | null = null;
	private cursor: number | null = null;
	/** Set on every successful enqueue. The reconnect loop resets the
	 * backoff counter when this is true at the start of a new attempt, so a
	 * subscription that connects, consumes events, and then drops doesn't
	 * spiral into ever-larger backoffs. */
	private madeProgress = false;

	constructor(opts: JetstreamIngestorOptions) {
		this.client = opts.client;
		this.queue = opts.queue;
		this.storage = opts.storage;
		this.wantedCollections = opts.wantedCollections ?? WANTED_COLLECTIONS;
		this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
		this.logger = opts.logger ?? {};
		this.sleep = opts.sleep ?? defaultSleep;
		this.random = opts.random ?? Math.random;
	}

	/** The cursor most recently enqueued + persisted. `null` until the first event. */
	get currentCursor(): number | null {
		return this.cursor;
	}

	/**
	 * Run the connect-consume-reconnect loop until `stop()` is called.
	 *
	 * Resolves when `stop()` is called and the current subscription drains.
	 * Does NOT reject for transient failures — connection drops, parse
	 * errors, queue.send rejections all increment the backoff counter and
	 * retry. The DO observes liveness via the `currentCursor` getter and
	 * the failure counter exposed on the ingestor. We could instead bubble
	 * queue failures and let the DO crash loud; current choice is to
	 * absorb them because Cloudflare Queues have transient failures and
	 * the cron liveness ping recovers the DO either way.
	 */
	async run(): Promise<void> {
		this.cursor = (await this.storage.get(CURSOR_STORAGE_KEY)) ?? null;

		while (!this.stopped) {
			try {
				await this.connectAndConsume();
				// Subscription ended cleanly. If we consumed at least one
				// event, the connection was healthy — reset the counter and
				// reconnect with the floor delay. Otherwise treat as a soft
				// failure and grow the backoff.
				if (this.madeProgress) this._consecutiveFailures = 0;
				else this._consecutiveFailures += 1;
			} catch (err) {
				if (this.madeProgress) this._consecutiveFailures = 0;
				else this._consecutiveFailures += 1;
				this.logger.warn?.("jetstream subscription failed", {
					error: err instanceof Error ? err.message : String(err),
					consecutiveFailures: this._consecutiveFailures,
				});
			}
			if (this.stopped) break;
			await this.sleep(this.computeBackoff(this._consecutiveFailures));
		}
	}

	/** Number of consecutive failed/empty connection attempts. Exposed for
	 * liveness probes; `0` means the most recent attempt produced events. */
	get consecutiveFailures(): number {
		return this._consecutiveFailures;
	}
	private _consecutiveFailures = 0;

	stop(): void {
		this.stopped = true;
		this.currentSub?.close();
	}

	private async connectAndConsume(): Promise<void> {
		// Tied to one connection attempt: set true when we actually enqueue
		// an event, read by the run loop to decide whether to reset
		// backoff. Resetting per-attempt (rather than per-loop-iteration at
		// the top of run()) keeps the flag's lifetime crisp.
		this.madeProgress = false;
		const sub = this.client.subscribe({
			wantedCollections: this.wantedCollections,
			...(this.cursor !== null ? { cursor: this.cursor } : {}),
		});
		this.currentSub = sub;
		try {
			for await (const event of sub) {
				if (this.stopped) break;
				await this.handleEvent(event);
			}
		} finally {
			sub.close();
			if (this.currentSub === sub) this.currentSub = null;
		}
	}

	private async handleEvent(event: JetstreamCommitEvent): Promise<void> {
		// Defence in depth: Jetstream filters server-side, but a future
		// subscription change or a malicious relay could deliver something
		// off-list. Trust nothing.
		if (!this.wantedCollections.includes(event.commit.collection)) return;

		const job: RecordsJob = {
			did: event.did,
			collection: event.commit.collection,
			rkey: event.commit.rkey,
			operation: event.commit.operation,
			cid: event.commit.operation === "delete" ? "" : event.commit.cid,
			...(event.commit.operation !== "delete" ? { jetstreamRecord: event.commit.record } : {}),
		};

		await this.queue.send(job);
		// Persist cursor only after the queue has accepted the message.
		// A crash between enqueue and persist replays the latest event on
		// recovery; the consumer's idempotency rules (DO NOTHING on
		// duplicate releases, upsert on profiles) absorb the duplicate.
		this.cursor = event.time_us;
		await this.storage.put(CURSOR_STORAGE_KEY, event.time_us);
		this.madeProgress = true;
	}

	private computeBackoff(failures: number): number {
		// Defensive: `failures` is always >= 1 when called from the run loop
		// (the increment happens before computeBackoff), but a future caller
		// passing 0 would give `initialDelayMs / multiplier`, which is below
		// the floor. Clamp explicitly.
		const exp = Math.min(
			Math.max(
				this.backoff.initialDelayMs,
				this.backoff.initialDelayMs * this.backoff.multiplier ** (failures - 1),
			),
			this.backoff.maxDelayMs,
		);
		if (this.backoff.jitter <= 0) return exp;
		const range = exp * this.backoff.jitter;
		const offset = (this.random() * 2 - 1) * range;
		return Math.max(0, Math.round(exp + offset));
	}
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
