/**
 * SHA-256 hashing and the digests that identify packages, plans, receipts,
 * and verified target state.
 *
 * Digest rules (formatVersion "1"):
 * - `packageDigest = "sha256:" + hex(sha256(utf8(canonicalJson(manifest))))`
 * - `planDigest = "sha256:" + hex(sha256(utf8(canonicalJson(plan))))` over the
 *   complete {@link SiteImportPlan} including its `decisions`, `packageDigest`
 *   and `target.siteId`, so a plan cannot be replayed against another package
 *   or target.
 * - `receiptDigest` covers the receipt with its `receiptDigest` property
 *   removed.
 * - A record's hash is the hex SHA-256 of its canonical JSON (the NDJSON line
 *   without its newline).
 * - A chunk's logical hash is
 *   `hex(sha256(utf8(canonicalJson([[id, recordSha256], …]))))` over the
 *   records of one package record chunk, in chunk order, each record in its
 *   predicted target form (after declared transformations).
 * - `logicalDigest = "sha256:" + hex(sha256(utf8(canonicalJson(chunks))))`
 *   where `chunks` is `[[kind, seq, chunkLogicalSha256], …]` for every record
 *   chunk in package order (kinds in `RECORD_KINDS` order, then `seq`).
 *   `principal` chunks are excluded because principals are never written to
 *   a target. The two-level shape lets verification run in bounded steps and
 *   persist one hash per chunk instead of an in-progress hash state.
 */

import { SHA256 } from "@oslojs/crypto/sha2";
import { encodeHexLowerCase } from "@oslojs/encoding";

import { canonicalJson } from "./canonical.js";

export type Sha256Digest = `sha256:${string}`;

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isSha256Hex(value: unknown): value is string {
	return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}

export function isSha256Digest(value: unknown): value is Sha256Digest {
	return typeof value === "string" && SHA256_DIGEST_PATTERN.test(value);
}

export function toSha256Digest(hex: string): Sha256Digest {
	if (!isSha256Hex(hex)) throw new TypeError("Expected a lowercase hex SHA-256");
	return `sha256:${hex}`;
}

export function sha256HexOf(digest: Sha256Digest): string {
	if (!isSha256Digest(digest)) throw new TypeError("Expected a sha256: digest");
	return digest.slice("sha256:".length);
}

/** Incremental SHA-256. `update` never retains the chunk after it returns. */
export interface Sha256Hasher {
	readonly backend: Sha256Backend;
	update(chunk: Uint8Array): void;
	/** Lowercase hex digest. The hasher must not be used afterwards. */
	digest(): Promise<string>;
}

export type Sha256Backend = "digest-stream" | "node" | "oslo";

interface DigestStreamLike extends WritableStream<ArrayBufferView | ArrayBuffer> {
	readonly digest: Promise<ArrayBuffer>;
}

type DigestStreamConstructor = new (algorithm: string) => DigestStreamLike;

interface NodeHash {
	update(data: Uint8Array): unknown;
	digest(encoding: "hex"): string;
}

type NodeCreateHash = (algorithm: string) => NodeHash;

function isDigestStreamConstructor(value: unknown): value is DigestStreamConstructor {
	return typeof value === "function";
}

function isNodeCreateHash(value: unknown): value is NodeCreateHash {
	return typeof value === "function";
}

function getDigestStream(): DigestStreamConstructor | undefined {
	const candidate: unknown =
		typeof globalThis.crypto === "object"
			? Reflect.get(globalThis.crypto, "DigestStream")
			: undefined;
	return isDigestStreamConstructor(candidate) ? candidate : undefined;
}

function isNodeRuntime(): boolean {
	const processLike: unknown = Reflect.get(globalThis, "process");
	if (typeof processLike !== "object" || processLike === null) return false;
	const versions: unknown = Reflect.get(processLike, "versions");
	return (
		typeof versions === "object" &&
		versions !== null &&
		typeof Reflect.get(versions, "node") === "string"
	);
}

let nodeCreateHash: Promise<NodeCreateHash | null> | undefined;

function loadNodeCreateHash(): Promise<NodeCreateHash | null> {
	nodeCreateHash ??= (async () => {
		if (!isNodeRuntime()) return null;
		try {
			const nodeCrypto: { createHash?: unknown } = await import("node:crypto");
			return isNodeCreateHash(nodeCrypto.createHash) ? nodeCrypto.createHash : null;
		} catch {
			return null;
		}
	})();
	return nodeCreateHash;
}

async function preferredBackend(): Promise<Sha256Backend> {
	if (getDigestStream()) return "digest-stream";
	if (await loadNodeCreateHash()) return "node";
	return "oslo";
}

class DigestStreamHasher implements Sha256Hasher {
	readonly backend = "digest-stream";
	readonly #stream: DigestStreamLike;
	readonly #writer: WritableStreamDefaultWriter<ArrayBufferView | ArrayBuffer>;
	#failure: unknown;

	constructor(DigestStream: DigestStreamConstructor) {
		this.#stream = new DigestStream("SHA-256");
		this.#writer = this.#stream.getWriter();
	}

	update(chunk: Uint8Array): void {
		// DigestStream consumes its input asynchronously; copy so the caller
		// may reuse its buffer as soon as update() returns.
		this.#writer.write(chunk.slice()).catch((error: unknown) => {
			this.#failure ??= error;
		});
	}

	async digest(): Promise<string> {
		await this.#writer.close();
		if (this.#failure !== undefined) throw this.#failure;
		return encodeHexLowerCase(new Uint8Array(await this.#stream.digest));
	}
}

class NodeHasher implements Sha256Hasher {
	readonly backend = "node";
	readonly #hash: NodeHash;

	constructor(createHash: NodeCreateHash) {
		this.#hash = createHash("sha256");
	}

	update(chunk: Uint8Array): void {
		this.#hash.update(chunk);
	}

	async digest(): Promise<string> {
		return this.#hash.digest("hex");
	}
}

class OsloHasher implements Sha256Hasher {
	readonly backend = "oslo";
	readonly #hash = new SHA256();

	update(chunk: Uint8Array): void {
		this.#hash.update(chunk);
	}

	async digest(): Promise<string> {
		return encodeHexLowerCase(this.#hash.digest());
	}
}

/**
 * Backends usable in this runtime, most preferred first: `crypto.DigestStream`
 * (workerd), `node:crypto`, then the pure-JS oslo implementation.
 */
export async function availableSha256Backends(): Promise<Sha256Backend[]> {
	const backends: Sha256Backend[] = [];
	if (getDigestStream()) backends.push("digest-stream");
	if (await loadNodeCreateHash()) backends.push("node");
	backends.push("oslo");
	return backends;
}

export async function createSha256(
	options: { backend?: Sha256Backend } = {},
): Promise<Sha256Hasher> {
	const backend = options.backend ?? (await preferredBackend());
	switch (backend) {
		case "digest-stream": {
			const DigestStream = getDigestStream();
			if (!DigestStream) throw new Error("crypto.DigestStream is not available");
			return new DigestStreamHasher(DigestStream);
		}
		case "node": {
			const createHash = await loadNodeCreateHash();
			if (!createHash) throw new Error("node:crypto is not available");
			return new NodeHasher(createHash);
		}
		case "oslo":
			return new OsloHasher();
	}
}

const encoder = new TextEncoder();

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
	const bytes = typeof data === "string" ? encoder.encode(data) : data;
	const hasher = await createSha256();
	hasher.update(bytes);
	return hasher.digest();
}

/** `"sha256:" + hex(sha256(utf8(canonicalJson(value))))`. */
export async function canonicalDigest(value: unknown): Promise<Sha256Digest> {
	return toSha256Digest(await sha256Hex(canonicalJson(value)));
}

/** Hex SHA-256 of a record's canonical JSON (its NDJSON line without the newline). */
export async function recordSha256(record: unknown): Promise<string> {
	return sha256Hex(canonicalJson(record));
}

export function packageDigest(manifest: unknown): Promise<Sha256Digest> {
	return canonicalDigest(manifest);
}

export function planDigest(plan: unknown): Promise<Sha256Digest> {
	return canonicalDigest(plan);
}

/** Digest over a receipt without its own `receiptDigest` property. */
export function receiptDigest(receipt: Record<string, unknown>): Promise<Sha256Digest> {
	const { receiptDigest: _ignored, ...rest } = receipt;
	return canonicalDigest(rest);
}

/** Hex logical hash of one record chunk from its `[id, recordSha256]` pairs in chunk order. */
export async function chunkLogicalSha256(
	records: ReadonlyArray<readonly [id: string, recordSha256: string]>,
): Promise<string> {
	for (const [, sha] of records) {
		if (!isSha256Hex(sha)) throw new TypeError("Expected a lowercase hex SHA-256");
	}
	return sha256Hex(canonicalJson(records.map(([id, sha]) => [id, sha])));
}

/** `logicalDigest` from `[kind, seq, chunkLogicalSha256]` tuples in package order. */
export async function logicalDigest(
	chunks: ReadonlyArray<readonly [kind: string, seq: number, chunkLogicalSha256: string]>,
): Promise<Sha256Digest> {
	for (const [, , sha] of chunks) {
		if (!isSha256Hex(sha)) throw new TypeError("Expected a lowercase hex SHA-256");
	}
	return canonicalDigest(chunks.map(([kind, seq, sha]) => [kind, seq, sha]));
}

/**
 * Pass-through stream that feeds every chunk to `hasher` and counts bytes.
 * Throws inside the stream as soon as more than `maxBytes` flow through.
 */
export function createHashingStream(
	hasher: Sha256Hasher,
	options: { maxBytes?: number; onLimitExceeded?: () => unknown } = {},
): { stream: TransformStream<Uint8Array, Uint8Array>; bytes: () => number } {
	let total = 0;
	const stream = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			total += chunk.byteLength;
			if (options.maxBytes !== undefined && total > options.maxBytes) {
				throw options.onLimitExceeded?.() ?? new RangeError("Stream exceeded its declared size");
			}
			hasher.update(chunk);
			controller.enqueue(chunk);
		},
	});
	return { stream, bytes: () => total };
}
