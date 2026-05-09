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

function wrapAtcuteSubscription(sub: JetstreamSubscription): JetstreamSubscriptionHandle {
	let closed = false;
	return {
		get cursor() {
			return sub.cursor;
		},
		close: () => {
			closed = true;
			// `@atcute/jetstream`'s subscription doesn't expose an explicit
			// close — closing the iterator drops the WebSocket. We rely on
			// the iterator's `return()` being invoked when the consumer
			// stops awaiting; nothing to do here.
		},
		[Symbol.asyncIterator](): AsyncIterator<JetstreamCommitEvent> {
			const inner = sub[Symbol.asyncIterator]();
			return {
				async next(): Promise<IteratorResult<JetstreamCommitEvent>> {
					while (!closed) {
						const result = await inner.next();
						if (result.done) return { value: undefined, done: true };
						const event = result.value;
						if (event.kind === "commit") {
							return { value: event as JetstreamCommitEvent, done: false };
						}
						// Skip identity/account events; loop until next commit.
					}
					return { value: undefined, done: true };
				},
				async return(): Promise<IteratorResult<JetstreamCommitEvent>> {
					closed = true;
					await inner.return?.();
					return { value: undefined, done: true };
				},
			};
		},
	};
}
