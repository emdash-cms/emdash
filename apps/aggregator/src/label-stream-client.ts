import { decodeFirst } from "@atcute/cbor";
import { fromBase64Url } from "@atcute/multibase";
import { parseSignedListingLabel, type SignedListingLabel } from "@emdash-cms/registry-moderation";

import { isPlainObject } from "./utils.js";

const MAX_LABELS_PER_FRAME = 200;
const MAX_BUFFERED_FRAMES = 256;
const MAX_FRAME_BYTES = 1024 * 1024;
const NON_NEGATIVE_INTEGER = /^(?:0|[1-9]\d*)$/;
const MAX_QUERY_LABELS = 250;
const MAX_QUERY_RESPONSE_BYTES = 2 * 1024 * 1024;
const QUERY_TIMEOUT_MS = 15_000;

export interface LabelStreamEvent {
	seq: number;
	labels: readonly unknown[];
}

export interface LabelStreamHandle extends AsyncIterable<LabelStreamEvent> {
	close(): void;
}

export interface LabelStreamClient {
	subscribe(endpoint: string, cursor: number): LabelStreamHandle;
}

export interface LabelQueryPage {
	labels: readonly SignedListingLabel[];
	nextCursor?: number;
}

export interface LabelQueryClient {
	query(endpoint: string, source: string, cursor: number): Promise<LabelQueryPage>;
}

export class LabelStreamError extends Error {
	override readonly name = "LabelStreamError";
	constructor(
		readonly error: string,
		message: string,
	) {
		super(message);
	}
}

export function decodeLabelStreamFrame(bytes: Uint8Array): LabelStreamEvent | null {
	if (bytes.byteLength > MAX_FRAME_BYTES) {
		throw new TypeError("subscribeLabels frame exceeds the byte limit");
	}
	let header: unknown;
	let remainder: Uint8Array;
	try {
		[header, remainder] = decodeFirst(bytes);
	} catch {
		throw new TypeError("subscribeLabels frame header is invalid CBOR");
	}
	if (!isPlainObject(header) || typeof header["op"] !== "number") {
		throw new TypeError("subscribeLabels frame header is invalid");
	}
	let payload: unknown;
	try {
		let payloadRemainder: Uint8Array;
		[payload, payloadRemainder] = decodeFirst(remainder);
		if (payloadRemainder.byteLength !== 0) {
			throw new TypeError("subscribeLabels frame contains trailing CBOR data");
		}
	} catch {
		throw new TypeError("subscribeLabels frame payload is invalid CBOR");
	}
	if (header["op"] === -1) {
		if (
			!isPlainObject(payload) ||
			typeof payload["error"] !== "string" ||
			typeof payload["message"] !== "string"
		) {
			throw new TypeError("subscribeLabels error frame is invalid");
		}
		throw new LabelStreamError(payload["error"], payload["message"]);
	}
	if (header["op"] !== 1) throw new TypeError("subscribeLabels frame op is unsupported");
	if (header["t"] !== "#labels") return null;
	if (!isPlainObject(payload)) throw new TypeError("#labels payload must be an object");
	const seq = payload["seq"];
	const labels = payload["labels"];
	if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
		throw new TypeError("#labels seq must be a positive safe integer");
	}
	if (!Array.isArray(labels) || labels.length < 1 || labels.length > MAX_LABELS_PER_FRAME) {
		throw new TypeError("#labels labels count is invalid");
	}
	return { seq, labels };
}

type Buffered = { value: LabelStreamEvent } | { error: unknown };

export class RealLabelStreamClient implements LabelStreamClient {
	subscribe(endpoint: string, cursor: number): LabelStreamHandle {
		const buffered: Buffered[] = [];
		let pending: {
			resolve: (value: IteratorResult<LabelStreamEvent>) => void;
			reject: (error: unknown) => void;
		} | null = null;
		let socket: WebSocket | null = null;
		let ended = false;

		const finish = (): void => {
			if (ended) return;
			ended = true;
			pending?.resolve({ value: undefined, done: true });
			pending = null;
		};
		const deliver = (entry: Buffered): void => {
			if (ended) return;
			if (pending) {
				const waiter = pending;
				pending = null;
				if ("error" in entry) waiter.reject(entry.error);
				else waiter.resolve({ value: entry.value, done: false });
				return;
			}
			buffered.push(entry);
			if (buffered.length > MAX_BUFFERED_FRAMES) {
				buffered.splice(0, buffered.length, {
					error: new Error("subscribeLabels inbound buffer overflow"),
				});
				socket?.close();
			}
		};

		void (async () => {
			try {
				const url = new URL("/xrpc/com.atproto.label.subscribeLabels", `${endpoint}/`);
				url.searchParams.set("cursor", String(cursor));
				const response = await fetch(url, { headers: { upgrade: "websocket" } });
				if (response.status !== 101 || !response.webSocket) {
					throw new Error(`subscribeLabels upgrade failed with status ${response.status}`);
				}
				socket = response.webSocket;
				socket.addEventListener("message", (event) => {
					if (!(event.data instanceof ArrayBuffer)) {
						deliver({ error: new TypeError("subscribeLabels message must be binary") });
						socket?.close();
						return;
					}
					try {
						const frame = decodeLabelStreamFrame(new Uint8Array(event.data));
						if (frame) deliver({ value: frame });
					} catch (error) {
						deliver({ error });
						socket?.close();
					}
				});
				socket.addEventListener("close", finish);
				socket.accept();
				if (ended) socket.close();
			} catch (error) {
				deliver({ error });
				finish();
			}
		})();

		return {
			close() {
				socket?.close();
				finish();
			},
			[Symbol.asyncIterator]() {
				return {
					next(): Promise<IteratorResult<LabelStreamEvent>> {
						const entry = buffered.shift();
						if (entry) {
							return "error" in entry
								? Promise.reject(entry.error)
								: Promise.resolve({ value: entry.value, done: false });
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
}

export class RealLabelQueryClient implements LabelQueryClient {
	constructor(
		private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
		private readonly timeoutMs = QUERY_TIMEOUT_MS,
		private readonly maxResponseBytes = MAX_QUERY_RESPONSE_BYTES,
	) {}

	async query(endpoint: string, source: string, cursor: number): Promise<LabelQueryPage> {
		const url = new URL("/xrpc/com.atproto.label.queryLabels", `${endpoint}/`);
		url.searchParams.append("uriPatterns", "*");
		url.searchParams.append("sources", source);
		url.searchParams.set("cursor", String(cursor));
		url.searchParams.set("limit", String(MAX_QUERY_LABELS));
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort("queryLabels timed out"), this.timeoutMs);
		let response: Response;
		let body: unknown;
		try {
			response = await this.fetcher(url, {
				headers: { accept: "application/json" },
				signal: controller.signal,
			});
			if (!response.ok) throw new Error(`queryLabels failed with status ${response.status}`);
			body = await readBoundedJson(response, this.maxResponseBytes);
		} finally {
			clearTimeout(timeout);
		}
		if (!isPlainObject(body) || !Array.isArray(body["labels"])) {
			throw new TypeError("queryLabels response is invalid");
		}
		if (body["labels"].length > MAX_QUERY_LABELS) {
			throw new TypeError(`queryLabels returned more than ${MAX_QUERY_LABELS} labels`);
		}
		const labels = body["labels"].map(parseJsonSignedLabel);
		const rawCursor = body["cursor"];
		if (rawCursor === undefined) return { labels };
		if (typeof rawCursor !== "string" || !NON_NEGATIVE_INTEGER.test(rawCursor)) {
			throw new TypeError("queryLabels cursor is invalid");
		}
		const nextCursor = Number(rawCursor);
		if (!Number.isSafeInteger(nextCursor) || nextCursor <= cursor) {
			throw new TypeError("queryLabels cursor did not advance");
		}
		return { labels, nextCursor };
	}
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
	const declaredLength = response.headers.get("content-length");
	if (declaredLength !== null) {
		const parsedLength = Number(declaredLength);
		if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
			throw new TypeError("queryLabels response exceeds the byte limit");
		}
	}
	if (!response.body) throw new TypeError("queryLabels response has no body");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel("queryLabels response exceeds the byte limit");
			throw new TypeError("queryLabels response exceeds the byte limit");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		throw new TypeError("queryLabels response is not valid UTF-8");
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new TypeError("queryLabels response is not valid JSON");
	}
}

function parseJsonSignedLabel(value: unknown): SignedListingLabel {
	if (!isPlainObject(value) || !isPlainObject(value["sig"])) {
		throw new TypeError("queryLabels label signature is invalid");
	}
	const encoded = value["sig"]["$bytes"];
	if (typeof encoded !== "string") throw new TypeError("queryLabels label signature is invalid");
	let bytes: Uint8Array;
	try {
		bytes = fromBase64Url(encoded);
	} catch {
		throw new TypeError("queryLabels label signature is invalid");
	}
	const label = { ...value, sig: bytes };
	return parseSignedListingLabel(label);
}
