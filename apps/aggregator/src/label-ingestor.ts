/**
 * Signed-label ingestor. Subscribes to one labeler's `subscribeLabels`
 * stream, verifies every label against the labeler's resolved `#atproto_label`
 * key, enqueues verified labels, and persists the cursor so reconnects resume
 * cleanly.
 *
 * Owns:
 *   - Connection lifecycle (connect → consume → disconnect → backoff →
 *     reconnect, indefinitely until `stop()` is called). Same shape as
 *     `JetstreamIngestor`.
 *   - Fail-closed verification: a label is enqueued only after its signature
 *     verifies against the configured labeler's key. One resolver-refresh
 *     retry per connection absorbs a key rotation landing mid-stream; a
 *     second failure closes the connection rather than skip the label —
 *     the labeler is untrusted from that point until it reconnects.
 *   - Cursor persistence after every label in a frame has been enqueued.
 *     Persisting only after all sends resolve means a crash mid-frame
 *     replays the whole frame on reconnect; the consumer's digest-keyed
 *     `ON CONFLICT DO NOTHING` absorbs the duplicate.
 *   - Exponential backoff with jitter, capped, reset on each connection
 *     attempt that made progress.
 *
 * Pure constructor injection — no DO/D1/Queue/cloudflare:workers imports —
 * so unit tests instantiate it directly with a fake `LabelStreamClient` + an
 * in-memory queue + a `Map`-backed cursor store + a fake resolver.
 */

import {
	parseSignedLabel,
	verifyLabelWithPublicKey,
	type SignedLabel,
} from "@emdash-cms/registry-moderation";

import { toWire } from "./label-ingest-types.js";
import type { LabelIngestJob } from "./label-ingest-types.js";
import type { LabelStreamClient, LabelStreamHandle } from "./label-stream-client.js";
import type { ResolvedLabelerIdentity } from "./labeler-resolver.js";

/** Subset of `Queue.send` we use; loose return type because workerd's
 * `Queue.send` resolves to `QueueSendResponse` while a hand-rolled in-memory
 * test queue resolves to `void` — neither matters to the ingestor. */
export interface LabelJobQueue {
	send(job: LabelIngestJob): Promise<unknown>;
}

/** Persisted cursor is the last fully processed frame `seq`. `get()` returns
 * `undefined` when nothing has been persisted yet (fresh labeler, DO
 * restart with empty D1 row) — the ingestor subscribes with `cursor: 0`. */
export interface LabelCursorStore {
	get(): Promise<number | undefined>;
	put(cursor: number): Promise<void>;
}

/** Narrow slice of `LabelerResolver` the ingestor needs. */
export interface LabelResolver {
	resolve(did: string): Promise<ResolvedLabelerIdentity>;
	/** Bypasses the cache for the single per-connection retry after a
	 * verification failure. */
	resolveFresh(did: string): Promise<ResolvedLabelerIdentity>;
}

export interface LabelIngestorBackoffConfig {
	/** Initial delay after the first disconnect (ms). Default 1s. */
	initialDelayMs?: number;
	/** Cap (ms). Default 60s. */
	maxDelayMs?: number;
	/** Multiplier per retry. Default 2. */
	multiplier?: number;
	/** ±jitter as a fraction of the delay. Default 0.2 (±20%). 0 disables. */
	jitter?: number;
}

export interface LabelIngestorLogger {
	info?(msg: string, ctx?: Record<string, unknown>): void;
	warn?(msg: string, ctx?: Record<string, unknown>): void;
	error?(msg: string, ctx?: Record<string, unknown>): void;
}

export interface LabelIngestorOptions {
	/** The labeler DID this ingestor serves. Every label's `src` must equal
	 * this exactly; a mismatch is treated as a verification failure. */
	did: string;
	client: LabelStreamClient;
	queue: LabelJobQueue;
	cursorStore: LabelCursorStore;
	resolver: LabelResolver;
	backoff?: LabelIngestorBackoffConfig;
	logger?: LabelIngestorLogger;
	/** Sleep impl, swap in tests to skip real backoff waits. */
	sleep?: (ms: number) => Promise<void>;
	/** Random source for jitter, swap in tests for determinism. */
	random?: () => number;
}

const DEFAULT_BACKOFF: Required<LabelIngestorBackoffConfig> = {
	initialDelayMs: 1_000,
	maxDelayMs: 60_000,
	multiplier: 2,
	jitter: 0.2,
};

export class LabelIngestor {
	private readonly did: string;
	private readonly client: LabelStreamClient;
	private readonly queue: LabelJobQueue;
	private readonly cursorStore: LabelCursorStore;
	private readonly resolver: LabelResolver;
	private readonly backoff: Required<LabelIngestorBackoffConfig>;
	private readonly logger: LabelIngestorLogger;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly random: () => number;

	private stopped = false;
	private currentSub: LabelStreamHandle | null = null;
	private cursor = 0;
	/** Set once a frame's labels are fully enqueued and its cursor persisted.
	 * Read by the run loop to decide whether to reset the backoff counter. */
	private madeProgress = false;

	private _consecutiveFailures = 0;

	constructor(opts: LabelIngestorOptions) {
		this.did = opts.did;
		this.client = opts.client;
		this.queue = opts.queue;
		this.cursorStore = opts.cursorStore;
		this.resolver = opts.resolver;
		this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
		this.logger = opts.logger ?? {};
		this.sleep = opts.sleep ?? defaultSleep;
		this.random = opts.random ?? Math.random;
	}

	/** The frame `seq` most recently enqueued + persisted. `0` until the
	 * first frame or if nothing was ever persisted. */
	get currentCursor(): number {
		return this.cursor;
	}

	/** Number of consecutive failed/empty connection attempts. `0` means the
	 * most recent attempt produced at least one fully processed frame. */
	get consecutiveFailures(): number {
		return this._consecutiveFailures;
	}

	/**
	 * Run the connect-consume-reconnect loop until `stop()` is called.
	 *
	 * Resolves when `stop()` is called and the current subscription drains.
	 * Does NOT reject for transient failures — connection drops, decode
	 * errors, verification failures, and queue.send rejections all increment
	 * the backoff counter and retry. The DO observes liveness via
	 * `currentCursor` and `consecutiveFailures`.
	 */
	async run(): Promise<void> {
		// Loaded inside the retry loop: a transient D1 failure at DO cold start
		// must count as a failed attempt and retry, not kill the loop for the
		// lifetime of the DO instance.
		let cursorLoaded = false;

		while (!this.stopped) {
			try {
				if (!cursorLoaded) {
					this.cursor = (await this.cursorStore.get()) ?? 0;
					cursorLoaded = true;
				}
				await this.connectAndConsume();
				if (this.madeProgress) this._consecutiveFailures = 0;
				else this._consecutiveFailures += 1;
			} catch (err) {
				if (this.madeProgress) this._consecutiveFailures = 0;
				else this._consecutiveFailures += 1;
				this.logger.warn?.("label stream subscription failed", {
					did: this.did,
					error: err instanceof Error ? err.message : String(err),
					consecutiveFailures: this._consecutiveFailures,
				});
			}
			if (this.stopped) break;
			await this.sleep(this.computeBackoff(this._consecutiveFailures));
		}
	}

	stop(): void {
		this.stopped = true;
		this.currentSub?.close();
	}

	private async connectAndConsume(): Promise<void> {
		this.madeProgress = false;

		const identity = await this.resolver.resolve(this.did);
		let publicKey = identity.publicKey;
		// One resolver-refresh retry per connection, spent on the first label
		// that fails verification. A second failure — either the retry itself,
		// or any later label once the retry is spent — closes the connection.
		let retryUsed = false;

		const sub = this.client.subscribe({ endpoint: identity.endpoint, cursor: this.cursor });
		this.currentSub = sub;
		try {
			for await (const event of sub) {
				if (this.stopped) break;

				const verified: SignedLabel[] = [];
				let verificationClosed = false;

				for (let frameIndex = 0; frameIndex < event.labels.length; frameIndex++) {
					const raw = event.labels[frameIndex];
					try {
						verified.push(await this.verifyOne(raw, publicKey));
						continue;
					} catch (err) {
						if (retryUsed) {
							this.logger.error?.("label verification failed", {
								did: this.did,
								seq: event.seq,
								frameIndex,
								error: err instanceof Error ? err.message : String(err),
							});
							verificationClosed = true;
							break;
						}
						retryUsed = true;
						try {
							const fresh = await this.resolver.resolveFresh(this.did);
							publicKey = fresh.publicKey;
							verified.push(await this.verifyOne(raw, publicKey));
							continue;
						} catch (retryErr) {
							this.logger.error?.("label verification failed after key refresh", {
								did: this.did,
								seq: event.seq,
								frameIndex,
								error: retryErr instanceof Error ? retryErr.message : String(retryErr),
							});
							verificationClosed = true;
							break;
						}
					}
				}

				if (verificationClosed) {
					// Fail closed: nothing from this frame is enqueued, the
					// cursor doesn't move, and the connection ends here (the
					// `finally` below closes `sub`). Earlier frames in this
					// connection don't count as progress — otherwise a stream
					// alternating good and unverifiable frames would reset the
					// backoff counter every connection and never escalate.
					this.madeProgress = false;
					break;
				}

				for (let frameIndex = 0; frameIndex < verified.length; frameIndex++) {
					await this.queue.send({
						src: this.did,
						sourceSequence: event.seq,
						frameIndex,
						label: toWire(verified[frameIndex]!),
					});
				}
				// Persist only after every send in the frame has resolved.
				this.cursor = event.seq;
				await this.cursorStore.put(event.seq);
				this.madeProgress = true;
			}
		} finally {
			sub.close();
			if (this.currentSub === sub) this.currentSub = null;
		}
	}

	private async verifyOne(
		raw: unknown,
		publicKey: ResolvedLabelerIdentity["publicKey"],
	): Promise<SignedLabel> {
		const label = parseSignedLabel(raw);
		if (label.src !== this.did) {
			throw new TypeError(
				`label.src '${label.src}' does not match configured labeler '${this.did}'`,
			);
		}
		await verifyLabelWithPublicKey({ label, expectedSource: this.did, publicKey });
		return label;
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
