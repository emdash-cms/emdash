/**
 * Jetstream client abstraction.
 *
 * Production wraps `@atcute/jetstream`'s `JetstreamSubscription`. Tests bind
 * `MockJetstream` from `@emdash-cms/atproto-test-utils`. The ingestor only
 * depends on this interface, so the same code path runs in both worlds.
 *
 * The shape mirrors the subset of `JetstreamSubscription` we actually use:
 *   - async-iterable of commit events (we don't process identity/account
 *     events today),
 *   - a `cursor` getter exposing the time_us of the most recent event the
 *     iterator has yielded — used to persist the cursor for reconnection,
 *   - an explicit close.
 *
 * Open question we may revisit: real Jetstream emits identity + account
 * events alongside commits. The ingestor narrows to commits today; if we
 * grow to care about identity events for handle changes, widen the event
 * type here and update the consumer.
 */

import { JetstreamSubscription } from "@atcute/jetstream";

export interface JetstreamCommitEvent {
	did: `did:${string}:${string}`;
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

export interface JetstreamSubscribeOptions {
	wantedCollections: readonly string[];
	cursor?: number;
}

export interface JetstreamSubscriptionHandle extends AsyncIterable<JetstreamCommitEvent> {
	readonly cursor: number;
	close(): void;
}

export interface JetstreamClient {
	subscribe(opts: JetstreamSubscribeOptions): JetstreamSubscriptionHandle;
}

/**
 * Production client backed by `@atcute/jetstream`. Filters non-commit events
 * before yielding, so the ingestor doesn't have to switch on `kind` every
 * iteration.
 */
export class RealJetstreamClient implements JetstreamClient {
	constructor(private readonly url: string) {}

	subscribe(opts: JetstreamSubscribeOptions): JetstreamSubscriptionHandle {
		const sub = new JetstreamSubscription({
			url: this.url,
			wantedCollections: [...opts.wantedCollections],
			...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
		});
		return wrapAtcuteSubscription(sub);
	}
}

/**
 * Minimum shape `wrapAtcuteSubscription` needs from its input: a `cursor`
 * getter and an async iterable of events with a `kind` discriminator. Both
 * `JetstreamSubscription` (production) and a stub-with-never-resolving-next
 * (the C2 regression test) satisfy this without casts.
 */
export interface RawJetstreamSubscription<E extends { kind: string }> extends AsyncIterable<E> {
	readonly cursor: number;
}

/**
 * Exported so tests can drive the wrapper against a stub subscription with a
 * never-resolving `next()` and verify that `close()` actually cancels the
 * pending await. Production callers should construct via `RealJetstreamClient`.
 */
export function wrapAtcuteSubscription<E extends { kind: string }>(
	sub: RawJetstreamSubscription<E>,
): JetstreamSubscriptionHandle {
	// Hoist the inner iterator so `close()` can reach it from outside the
	// iterator factory.
	let inner: AsyncIterator<E> | null = null;
	// Shutdown signal raced against `inner.next()`. We can't rely on
	// `inner.return()` to unblock a pending `next()` — `@mary-ext/event-iterator`
	// drops its resolver on `return()` without invoking it (lib/index.ts:55-67),
	// so a quiescent stream's pending `next()` Promise leaks. Racing against
	// `closedSignal` lets the consumer wake regardless of the inner iterator's
	// behaviour. The orphaned `it.next()` Promise is one of:
	//   - resolved later when an event arrives (harmless, garbage-collected).
	//   - leaked forever if Jetstream stays quiescent (no value held; only
	//     the Promise object is GC-rooted by the inner iterator's #resolve).
	let resolveClosed: (() => void) | null = null;
	const closedSignal = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	const fireClosed = () => {
		if (resolveClosed) {
			const r = resolveClosed;
			resolveClosed = null;
			r();
		}
	};

	return {
		get cursor() {
			return sub.cursor;
		},
		close: () => {
			fireClosed();
			// `.catch` swallows rejections from the inner iterator's cleanup
			// (an EventIterator's `return()` shouldn't reject, but a future
			// implementation could). Without this, a rejection here would
			// surface as an unhandled-promise warning in workerd.
			inner?.return?.()?.catch(() => {});
		},
		[Symbol.asyncIterator](): AsyncIterator<JetstreamCommitEvent> {
			inner ??= sub[Symbol.asyncIterator]();
			const it = inner;
			return {
				async next(): Promise<IteratorResult<JetstreamCommitEvent>> {
					for (;;) {
						const result = await Promise.race([
							it.next(),
							closedSignal.then((): IteratorResult<E> => ({ value: undefined, done: true })),
						]);
						if (result.done) return { value: undefined, done: true };
						const event = result.value;
						if (isCommitEvent(event)) {
							return { value: event, done: false };
						}
						// Skip identity/account events; loop until next commit.
					}
				},
				async return(): Promise<IteratorResult<JetstreamCommitEvent>> {
					fireClosed();
					await it.return?.();
					return { value: undefined, done: true };
				},
			};
		},
	};
}

/**
 * Discriminator + structural predicate that narrows to `JetstreamCommitEvent`.
 *
 * The runtime check verifies BOTH `kind === "commit"` AND that `commit` is
 * present and shaped enough for the ingestor's downstream access (it reads
 * `event.commit.collection`, `event.commit.rkey`, `event.commit.operation`,
 * `event.commit.cid`). Without the structural check, a producer emitting
 * `{kind: "commit"}` with no `commit` field would crash the ingestor on
 * access; the cursor wouldn't advance; Jetstream would replay the same
 * malformed event forever.
 */
/** Wider parameter type than the bare `{ kind: string }` constraint so the
 * predicate can inspect `commit` without an unsafe cast. Any producer
 * conforming to `RawJetstreamSubscription<E>` where `E extends { kind: string }`
 * is assignable here because `commit` is optional. */
type MaybeCommitEvent = {
	kind: string;
	commit?: {
		collection?: unknown;
		rkey?: unknown;
		operation?: unknown;
		cid?: unknown;
	};
};

const KNOWN_OPERATIONS = new Set(["create", "update", "delete"]);

function isCommitEvent(event: MaybeCommitEvent): event is JetstreamCommitEvent {
	if (event.kind !== "commit" || event.commit === undefined) return false;
	const c = event.commit;
	if (typeof c.collection !== "string" || typeof c.rkey !== "string") return false;
	// Restrict to the operations the downstream RecordsJob + applyDelete
	// dispatcher know about. An unknown operation slipping through would
	// produce a job the consumer can't process and would land in
	// dead_letters as UNEXPECTED_ERROR — better to drop it at the source.
	if (typeof c.operation !== "string" || !KNOWN_OPERATIONS.has(c.operation)) return false;
	// `cid` is required for create/update (the ingestor reads it into the
	// RecordsJob); delete events legitimately have no cid.
	if (c.operation !== "delete" && typeof c.cid !== "string") return false;
	return true;
}
