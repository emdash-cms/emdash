/**
 * Driveable Jetstream mock.
 *
 * Tests construct a MockJetstream, register subscribers (the aggregator's
 * Records DO uses one), and drive events into the stream with `emit()` or
 * the higher-level `emitCommit()` helper. Subscribers receive events through
 * an async iterable matching the shape `@atcute/jetstream`'s
 * `JetstreamSubscription` exposes — so the aggregator code is identical
 * across tests and production.
 *
 * Disconnects are simulated by calling `closeSubscriber(id)`. Reconnections
 * with cursors replay events recorded since that cursor; full-replay (cursor
 * 0 or omitted) replays the whole history. This mirrors Jetstream's actual
 * behaviour closely enough that the records-DO's reconnect logic can be
 * tested against the mock.
 */

import type { AtprotoDid } from "./types.js";

/**
 * Simplified Jetstream commit-event shape. Matches what the aggregator's
 * records consumer reads (`did`, `commit.collection`, `commit.rkey`,
 * `commit.operation`, `commit.cid`, optionally `commit.record`).
 */
export interface JetstreamCommitEvent {
	did: AtprotoDid;
	time_us: number;
	kind: "commit";
	commit:
		| {
				rev: string;
				collection: string;
				rkey: string;
				operation: "create" | "update";
				cid: string;
				record: Record<string, unknown>;
		  }
		| {
				rev: string;
				collection: string;
				rkey: string;
				operation: "delete";
		  };
}

export type JetstreamEvent = JetstreamCommitEvent;

interface ActiveSubscriber {
	id: string;
	wantedCollections: ReadonlySet<string> | null;
	wantedDids: ReadonlySet<AtprotoDid> | null;
	queue: JetstreamEvent[];
	resolve: (() => void) | null;
	closed: boolean;
	/** time_us of the most recent event delivered to this subscriber's
	 * iterator. Exposed via the `cursor` getter so a reconnection with this
	 * value resumes strictly after the last delivery. 0 means "nothing
	 * delivered yet"; reconnecting with 0 replays full history. */
	lastDeliveredTimeUs: number;
}

export interface MockJetstreamSubscribeOptions {
	wantedCollections?: string[];
	wantedDids?: AtprotoDid[];
	cursor?: number;
}

export interface MockJetstreamSubscription extends AsyncIterable<JetstreamEvent> {
	readonly id: string;
	readonly cursor: number;
	close(): void;
}

export class MockJetstream {
	/** Append-only history. New subscribers with cursor=0 replay this; reconnects replay from `cursor` forward. */
	private history: JetstreamEvent[] = [];
	private subscribers = new Map<string, ActiveSubscriber>();
	private nextSubId = 0;
	private timeUs = Date.now() * 1000;

	/**
	 * Drive an event into the stream. All matching subscribers receive it; the
	 * event is appended to history so a future reconnection can replay it.
	 */
	emit(event: JetstreamEvent): void {
		this.history.push(event);
		for (const sub of this.subscribers.values()) {
			if (sub.closed) continue;
			if (!subscriberWants(sub, event)) continue;
			sub.queue.push(event);
			if (sub.resolve) {
				const r = sub.resolve;
				sub.resolve = null;
				r();
			}
		}
	}

	/**
	 * Convenience: synthesise a commit event for an existing record. Tests
	 * usually call this after putting a record into a FakeRepo so the event's
	 * `(did, collection, rkey)` resolve when the aggregator follows up with a
	 * verified PDS fetch.
	 */
	emitCommit(args: {
		did: AtprotoDid;
		collection: string;
		rkey: string;
		operation?: "create" | "update";
		cid?: string;
		record?: Record<string, unknown>;
		rev?: string;
	}): JetstreamCommitEvent {
		this.timeUs += 1;
		const event: JetstreamCommitEvent = {
			did: args.did,
			time_us: this.timeUs,
			kind: "commit",
			commit: {
				rev: args.rev ?? generateRev(),
				collection: args.collection,
				rkey: args.rkey,
				operation: args.operation ?? "create",
				cid: args.cid ?? "bafyreigfakecidplaceholder0000000000000000000000000",
				record: args.record ?? {},
			},
		};
		this.emit(event);
		return event;
	}

	subscribe(opts: MockJetstreamSubscribeOptions = {}): MockJetstreamSubscription {
		const id = String(++this.nextSubId);
		const sub: ActiveSubscriber = {
			id,
			wantedCollections: opts.wantedCollections ? new Set(opts.wantedCollections) : null,
			wantedDids: opts.wantedDids ? new Set(opts.wantedDids) : null,
			queue: [],
			resolve: null,
			closed: false,
			lastDeliveredTimeUs: 0,
		};
		// Replay history strictly after the cursor. Real Jetstream treats the
		// cursor as "last seen, don't redeliver" — reconnecting with cursor=N
		// must NOT include the event whose time_us is exactly N. cursor=0
		// (or omitted) replays everything.
		const cursor = opts.cursor ?? 0;
		for (const event of this.history) {
			if (event.time_us <= cursor) continue;
			if (!subscriberWants(sub, event)) continue;
			sub.queue.push(event);
		}
		this.subscribers.set(id, sub);

		const subscribers = this.subscribers;
		const iterable: MockJetstreamSubscription = {
			id,
			// Per-subscriber cursor: the time_us of the most recent event the
			// iterator has yielded. Reconnecting with this value resumes
			// strictly after that point, which is what every real subscriber
			// needs. Returning the global head (the previous behaviour) made
			// disconnect-then-reconnect silently drop everything between
			// `consumed` and `globalHead`.
			get cursor() {
				return sub.lastDeliveredTimeUs;
			},
			close: () => {
				sub.closed = true;
				subscribers.delete(id);
				if (sub.resolve) {
					const r = sub.resolve;
					sub.resolve = null;
					r();
				}
			},
			[Symbol.asyncIterator]: () => ({
				async next() {
					while (true) {
						const event = sub.queue.shift();
						if (event) {
							sub.lastDeliveredTimeUs = event.time_us;
							return { value: event, done: false };
						}
						if (sub.closed) return { value: undefined, done: true };
						// next() is documented as single-consumer. If a caller
						// invokes it concurrently, the second await would
						// orphan the first resolver. Detect and fail loudly.
						if (sub.resolve !== null) {
							throw new Error(
								"MockJetstreamSubscription.next() called concurrently from two consumers; this is not supported",
							);
						}
						await new Promise<void>((resolve) => {
							sub.resolve = resolve;
						});
					}
				},
				async return() {
					iterable.close();
					return { value: undefined, done: true };
				},
			}),
		};
		return iterable;
	}

	/** Close a subscriber by id. Simulates a connection drop. */
	closeSubscriber(id: string): void {
		const sub = this.subscribers.get(id);
		if (sub) {
			sub.closed = true;
			this.subscribers.delete(id);
			if (sub.resolve) {
				const r = sub.resolve;
				sub.resolve = null;
				r();
			}
		}
	}

	/** Drop everyone. Useful for `afterEach` cleanup. Iterates over values
	 * (no snapshot needed) and clears the map after, instead of repeatedly
	 * calling `closeSubscriber` which would mutate the iterator. */
	closeAll(): void {
		for (const sub of this.subscribers.values()) {
			sub.closed = true;
			if (sub.resolve) {
				const r = sub.resolve;
				sub.resolve = null;
				r();
			}
		}
		this.subscribers.clear();
	}
}

function subscriberWants(sub: ActiveSubscriber, event: JetstreamEvent): boolean {
	if (sub.wantedDids && !sub.wantedDids.has(event.did)) return false;
	if (sub.wantedCollections) {
		if (event.kind === "commit" && !sub.wantedCollections.has(event.commit.collection))
			return false;
	}
	return true;
}

function generateRev(): string {
	// Real atproto revs are TIDs (base32 timestamp+randomness). Tests don't
	// validate rev format, so we just return something opaque and unique.
	return `rev-${Math.random().toString(36).slice(2, 12)}`;
}
