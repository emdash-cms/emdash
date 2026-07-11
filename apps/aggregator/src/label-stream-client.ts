/**
 * Signed-label subscription transport (`com.atproto.label.subscribeLabels`).
 *
 * Mirrors the `JetstreamClient`/`RealJetstreamClient` split in
 * `jetstream-client.ts`: a narrow interface the ingestor depends on, plus a
 * production implementation. Unlike Jetstream (wrapped from `@atcute/jetstream`),
 * there's no library for this XRPC subscription — we hand-roll the WebSocket
 * over a `fetch` upgrade and the two-CBOR-value frame format the labeler
 * writes in `apps/labeler/src/subscribe-labels.ts` (`encodeEvent`).
 *
 * Frame shape: a CBOR-encoded header object concatenated with a CBOR-encoded
 * payload object in one binary WebSocket message — `decodeFirst` twice, no
 * length prefix. Two message kinds:
 *   - `{ op: 1, t: "#labels" }` header, `{ seq, labels }` payload — one
 *     labeler event. Structurally validated here; label contents stay
 *     `unknown[]` because parsing/verification is the ingestor's job.
 *   - `{ op: -1 }` header, `{ error, message }` payload — the labeler is
 *     refusing the subscription (e.g. `FutureCursor`). Thrown as
 *     `LabelStreamError`; the ingestor logs and backs off rather than
 *     resetting its cursor.
 *
 * An unknown `t` under `op: 1` is ignored for forward compatibility. Anything
 * else — bad CBOR, wrong shape, unrecognised `op` — throws, because a label
 * stream we can't parse is a stream we must not silently skip past.
 */

import { decodeFirst } from "@atcute/cbor";

import { isPlainObject } from "./utils.js";

const MAX_LABELS_PER_FRAME = 200;

export interface LabelStreamEvent {
	seq: number;
	labels: unknown[];
}

export interface LabelStreamSubscribeOptions {
	endpoint: string;
	/** Always sent explicitly — the labeler's default cursor is "now", which
	 * would silently skip history. */
	cursor: number;
}

export interface LabelStreamHandle extends AsyncIterable<LabelStreamEvent> {
	close(): void;
}

export interface LabelStreamClient {
	subscribe(opts: LabelStreamSubscribeOptions): LabelStreamHandle;
}

/** Carries the labeler's `{ error, message }` payload from an `op: -1` frame. */
export class LabelStreamError extends Error {
	override readonly name = "LabelStreamError";
	constructor(
		readonly error: string,
		message: string,
	) {
		super(message);
	}
}

/**
 * Decodes and structurally validates one binary subscribeLabels message.
 * Exported as the test seam for `label-stream-client.test.ts` — same role as
 * `wrapAtcuteSubscription` in `jetstream-client.ts`: exercise the decode path
 * directly instead of standing up a real socket.
 *
 * Returns `null` for a forward-compatible `op: 1` frame with an unrecognised
 * `t` (ignore and keep reading). Throws `LabelStreamError` for `op: -1`.
 * Throws a plain `TypeError` for anything malformed or structurally invalid.
 */
export function decodeLabelStreamFrame(bytes: Uint8Array): LabelStreamEvent | null {
	let header: unknown;
	let remainder: Uint8Array;
	try {
		[header, remainder] = decodeFirst(bytes);
	} catch {
		throw new TypeError("subscribeLabels frame header failed to decode as CBOR");
	}
	if (!isPlainObject(header) || typeof header["op"] !== "number") {
		throw new TypeError("subscribeLabels frame header must be an object with a numeric op");
	}

	let payload: unknown;
	try {
		[payload] = decodeFirst(remainder);
	} catch {
		throw new TypeError("subscribeLabels frame payload failed to decode as CBOR");
	}

	const op = header["op"];
	if (op === -1) {
		if (
			!isPlainObject(payload) ||
			typeof payload["error"] !== "string" ||
			typeof payload["message"] !== "string"
		) {
			throw new TypeError("subscribeLabels error frame must carry string error and message fields");
		}
		throw new LabelStreamError(payload["error"], payload["message"]);
	}
	if (op !== 1) {
		throw new TypeError(`subscribeLabels frame has unsupported op: ${op}`);
	}
	if (header["t"] !== "#labels") return null;
	return validateLabelsPayload(payload);
}

function validateLabelsPayload(payload: unknown): LabelStreamEvent {
	if (!isPlainObject(payload)) {
		throw new TypeError("#labels frame payload must be an object");
	}
	const seq = payload["seq"];
	if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) {
		throw new TypeError("#labels frame seq must be a positive safe integer");
	}
	const labels = payload["labels"];
	if (!Array.isArray(labels) || labels.length === 0) {
		throw new TypeError("#labels frame labels must be a non-empty array");
	}
	if (labels.length > MAX_LABELS_PER_FRAME) {
		throw new TypeError(
			`#labels frame labels must contain at most ${MAX_LABELS_PER_FRAME} entries`,
		);
	}
	return { seq, labels };
}

type QueueEntry = { kind: "value"; value: LabelStreamEvent } | { kind: "error"; error: unknown };

interface PendingNext {
	resolve(result: IteratorResult<LabelStreamEvent>): void;
	reject(error: unknown): void;
}

/**
 * Production client: opens the WebSocket via a `fetch` upgrade (workerd's
 * outbound WebSocket idiom — there's no browser `new WebSocket()` here) and
 * adapts the event-driven socket into a pull-based async iterator.
 *
 * Buffering scheme: decoded frames (or decode errors) land in a small FIFO
 * queue as they arrive; a pending `next()` call is handed the head of the
 * queue directly instead of buffering it, so a fast consumer never pays for
 * the queue at all. `close()` unblocks a pending `next()` immediately
 * (`done: true`) rather than waiting on the socket's own close event, which
 * may never come if the remote end is unresponsive.
 */
export class RealLabelStreamClient implements LabelStreamClient {
	subscribe(opts: LabelStreamSubscribeOptions): LabelStreamHandle {
		return createHandle(opts);
	}
}

function createHandle(opts: LabelStreamSubscribeOptions): LabelStreamHandle {
	const queue: QueueEntry[] = [];
	let pending: PendingNext | null = null;
	let ended = false;
	let socket: WebSocket | null = null;

	const deliver = (entry: QueueEntry): void => {
		if (ended) return;
		if (pending) {
			const waiter = pending;
			pending = null;
			if (entry.kind === "error") waiter.reject(entry.error);
			else waiter.resolve({ value: entry.value, done: false });
			return;
		}
		queue.push(entry);
	};

	const finish = (): void => {
		if (ended) return;
		ended = true;
		if (pending) {
			const waiter = pending;
			pending = null;
			waiter.resolve({ value: undefined, done: true });
		}
	};

	const handleMessage = (data: ArrayBuffer): void => {
		let decoded: LabelStreamEvent | null;
		try {
			decoded = decodeLabelStreamFrame(new Uint8Array(data));
		} catch (err) {
			deliver({ kind: "error", error: err });
			// Fail closed: don't keep reading a stream we can't parse.
			socket?.close();
			return;
		}
		if (decoded !== null) deliver({ kind: "value", value: decoded });
	};

	void (async () => {
		try {
			const url = `${opts.endpoint}/xrpc/com.atproto.label.subscribeLabels?cursor=${opts.cursor}`;
			const response = await fetch(url, { headers: { upgrade: "websocket" } });
			if (response.status !== 101 || !response.webSocket) {
				throw new Error(`subscribeLabels upgrade failed with status ${response.status}`);
			}
			socket = response.webSocket;
			socket.accept();
			if (ended) {
				// close() won the race against the upgrade: without this the
				// accepted socket would stay open with nobody reading it.
				socket.close();
				return;
			}
			socket.addEventListener("message", (event: MessageEvent) => {
				if (!(event.data instanceof ArrayBuffer)) {
					deliver({
						kind: "error",
						error: new TypeError("subscribeLabels message was not binary"),
					});
					socket?.close();
					return;
				}
				handleMessage(event.data);
			});
			// Code 1013 is the labeler's backpressure signal (see
			// `apps/labeler/src/subscribe-labels.ts`'s `send`): the subscriber
			// must reconnect with a cursor. Every other close code also just
			// ends the iterator — the run loop's reconnect-with-backoff handles
			// both cases identically.
			socket.addEventListener("close", () => {
				finish();
			});
		} catch (err) {
			deliver({ kind: "error", error: err });
			finish();
		}
	})();

	return {
		close(): void {
			socket?.close();
			finish();
		},
		[Symbol.asyncIterator](): AsyncIterator<LabelStreamEvent> {
			return {
				next(): Promise<IteratorResult<LabelStreamEvent>> {
					const entry = queue.shift();
					if (entry) {
						if (entry.kind === "error") return Promise.reject(entry.error);
						return Promise.resolve({ value: entry.value, done: false });
					}
					if (ended) return Promise.resolve({ value: undefined, done: true });
					return new Promise((resolve, reject) => {
						pending = { resolve, reject };
					});
				},
				return(): Promise<IteratorResult<LabelStreamEvent>> {
					finish();
					return Promise.resolve({ value: undefined, done: true });
				},
			};
		},
	};
}
