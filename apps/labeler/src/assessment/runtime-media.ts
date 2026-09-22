import type { DisplayMediaDecoder, GuardedMediaTransport, MediaContentStore } from "./media.js";

const HEADER_END = new Uint8Array([13, 10, 13, 10]);
const CRLF = new Uint8Array([13, 10]);
const STATUS_LINE_RE = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: .*)?$/;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FOLDED_HEADER_RE = /^[ \t]/;
const CONTENT_LENGTH_RE = /^(0|[1-9][0-9]*)$/;
const CHUNK_SIZE_RE = /^[0-9A-Fa-f]+$/;
const R2_MEDIA_KEY_RE =
	/^media\/[a-f0-9]{64}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const MAX_HEADER_BYTES = 32 * 1024;
const MAX_SOCKET_RESPONSE_BYTES = 8 * 1024 * 1024 + MAX_HEADER_BYTES;
const R2_CONTENT_REF_PREFIX = "r2://quarantine/";
const MEDIA_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MEDIA_CLAIM_LEASE_MS = 5 * 60 * 1_000;

export interface ParsedPinnedHttpResponse {
	status: number;
	headers: Headers;
	body: Uint8Array;
}

export type SocketConnect = typeof import("cloudflare:sockets").connect;

export function createWorkersSocketPinnedTransport(connect: SocketConnect): GuardedMediaTransport {
	return {
		async fetch(input) {
			const url = new URL(input.url);
			let lastError: unknown;
			for (const address of input.allowedAddresses) {
				if (input.signal.aborted || Date.now() >= input.deadline) {
					throw new Error("display media connection deadline exceeded");
				}
				let socket: Socket | undefined;
				let tls: Socket | undefined;
				try {
					const rawSocket = connect(
						{ hostname: address, port: 443 },
						{ secureTransport: "starttls", allowHalfOpen: false },
					);
					socket = rawSocket;
					await abortable(rawSocket.opened, input.signal, () => rawSocket.close());
					const secureSocket = rawSocket.startTls({ expectedServerHostname: url.hostname });
					tls = secureSocket;
					await abortable(secureSocket.opened, input.signal, () => secureSocket.close());
					const writer = secureSocket.writable.getWriter();
					try {
						await abortable(writer.write(buildHttpRequest(url, input.headers)), input.signal, () =>
							secureSocket.close(),
						);
					} finally {
						writer.releaseLock();
					}
					const bytes = await readSocketResponse(secureSocket, input.signal);
					await secureSocket.close().catch(() => undefined);
					const parsed = parsePinnedHttpResponse(bytes);
					return {
						response: new Response(parsed.body, {
							status: parsed.status,
							headers: parsed.headers,
						}),
						connectedAddress: address,
					};
				} catch (error) {
					await Promise.all([
						tls?.close().catch(() => undefined),
						socket?.close().catch(() => undefined),
					]);
					if (input.signal.aborted || Date.now() >= input.deadline) throw error;
					lastError = error;
				}
			}
			throw new Error("display media could not connect to an approved address", {
				cause: lastError,
			});
		},
	};
}

export function createR2MediaContentStore(bucket: R2Bucket, db: D1Database): MediaContentStore {
	return {
		async put(input) {
			if (input.signal.aborted) throw new Error("display media storage was aborted");
			const checksum = hexToBytes(input.sha256);
			let claim = await readMediaClaim(db, input.idempotencyKey);
			if (!claim) {
				const key = `media/${input.sha256}/${crypto.randomUUID()}`;
				const createdAt = new Date().toISOString();
				const expiresAt = new Date(Date.parse(createdAt) + MEDIA_RETENTION_MS).toISOString();
				await db
					.prepare(
						`INSERT INTO media_quarantine_objects
						   (object_key, idempotency_key, sha256, byte_length, created_at, expires_at, ready)
						 VALUES (?, ?, ?, ?, ?, ?, 0)
						 ON CONFLICT(idempotency_key) DO NOTHING`,
					)
					.bind(
						key,
						input.idempotencyKey,
						input.sha256,
						input.bytes.byteLength,
						createdAt,
						expiresAt,
					)
					.run();
				claim = await readMediaClaim(db, input.idempotencyKey);
			}
			if (!claim) throw new Error("display media storage claim was not persisted");
			assertMediaClaimMatches(claim, input.sha256);
			const leaseToken = crypto.randomUUID();
			const leaseStartedAt = new Date();
			const leaseExpiresAt = new Date(
				leaseStartedAt.getTime() + MEDIA_CLAIM_LEASE_MS,
			).toISOString();
			const retentionExpiresAt = new Date(
				leaseStartedAt.getTime() + MEDIA_RETENTION_MS,
			).toISOString();
			const acquired = await db
				.prepare(
					`UPDATE media_quarantine_objects
					 SET lease_token = ?, lease_expires_at = ?
					 WHERE object_key = ? AND idempotency_key = ?
					   AND (lease_token IS NULL OR lease_expires_at <= ?)`,
				)
				.bind(
					leaseToken,
					leaseExpiresAt,
					claim.objectKey,
					input.idempotencyKey,
					leaseStartedAt.toISOString(),
				)
				.run();
			if (acquired.meta.changes !== 1) {
				throw new Error("display media storage claim is leased by another recovery");
			}
			try {
				const existing = await bucket.head(claim.objectKey);
				if (!storedMediaMatches(existing, input)) {
					await bucket.put(claim.objectKey, input.bytes, {
						httpMetadata: { contentType: input.mimeType },
						customMetadata: {
							sha256: input.sha256,
							width: String(input.width),
							height: String(input.height),
							frames: String(input.frames),
						},
						sha256: checksum,
					});
				}
				if (input.signal.aborted) throw new Error("display media storage was aborted");
				const finalized = await db
					.prepare(
						`UPDATE media_quarantine_objects
						 SET ready = 1, expires_at = ?, lease_token = NULL, lease_expires_at = NULL
						 WHERE object_key = ? AND idempotency_key = ? AND lease_token = ?`,
					)
					.bind(retentionExpiresAt, claim.objectKey, input.idempotencyKey, leaseToken)
					.run();
				if (finalized.meta.changes !== 1) {
					throw new Error("display media storage claim lease was lost during recovery");
				}
				const settled = await readMediaClaim(db, input.idempotencyKey);
				if (!settled) throw new Error("display media storage claim disappeared during recovery");
				return settledMediaClaim(settled, input.sha256, input.contentAddress);
			} finally {
				await db
					.prepare(
						`UPDATE media_quarantine_objects
						 SET lease_token = NULL, lease_expires_at = NULL
						 WHERE object_key = ? AND lease_token = ?`,
					)
					.bind(claim.objectKey, leaseToken)
					.run();
			}
		},
	};
}

export async function purgeExpiredMediaQuarantine(
	db: D1Database,
	bucket: R2Bucket,
	now = new Date(),
	limit = 100,
): Promise<{ deleted: number; remaining: boolean }> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
		throw new TypeError("media quarantine purge limit is invalid");
	}
	const nowIso = now.toISOString();
	const rows = await db
		.prepare(
			`SELECT object_key FROM media_quarantine_objects
			 WHERE expires_at <= ?
			   AND (lease_token IS NULL OR lease_expires_at <= ?)
			 ORDER BY expires_at ASC, object_key ASC
			 LIMIT ?`,
		)
		.bind(nowIso, nowIso, limit + 1)
		.all<{ object_key: string }>();
	const selected = rows.results.slice(0, limit);
	let deleted = 0;
	for (const row of selected) {
		const purgeToken = crypto.randomUUID();
		const claimed = await db
			.prepare(
				`UPDATE media_quarantine_objects
				 SET lease_token = ?, lease_expires_at = ?
				 WHERE object_key = ? AND expires_at <= ?
				   AND (lease_token IS NULL OR lease_expires_at <= ?)`,
			)
			.bind(
				purgeToken,
				new Date(now.getTime() + MEDIA_CLAIM_LEASE_MS).toISOString(),
				row.object_key,
				nowIso,
				nowIso,
			)
			.run();
		if (claimed.meta.changes !== 1) continue;
		try {
			await bucket.delete(row.object_key);
			const removed = await db
				.prepare(
					`DELETE FROM media_quarantine_objects
					 WHERE object_key = ? AND expires_at <= ? AND lease_token = ?`,
				)
				.bind(row.object_key, nowIso, purgeToken)
				.run();
			deleted += removed.meta.changes;
		} catch (error) {
			await db
				.prepare(
					`UPDATE media_quarantine_objects
					 SET lease_token = NULL, lease_expires_at = NULL
					 WHERE object_key = ? AND lease_token = ?`,
				)
				.bind(row.object_key, purgeToken)
				.run();
			throw error;
		}
	}
	const remaining = await db
		.prepare("SELECT 1 AS pending FROM media_quarantine_objects WHERE expires_at <= ? LIMIT 1")
		.bind(nowIso)
		.first<number>("pending");
	return { deleted, remaining: remaining === 1 };
}

export function createR2ModerationMediaReader(bucket: R2Bucket) {
	return {
		async read(input: { contentRef: string; expectedSha256: string; maxBytes: number }) {
			if (!input.contentRef.startsWith(R2_CONTENT_REF_PREFIX)) {
				throw new TypeError("moderation media reference is not an R2 quarantine object");
			}
			const key = input.contentRef.slice(R2_CONTENT_REF_PREFIX.length);
			if (!R2_MEDIA_KEY_RE.test(key) || !key.startsWith(`media/${input.expectedSha256}/`)) {
				throw new TypeError("moderation media reference does not match its expected hash");
			}
			const object = await bucket.get(key);
			if (!object) throw new Error("moderation media quarantine object is missing");
			if (object.size > input.maxBytes) {
				await object.body.cancel();
				throw new RangeError("moderation media quarantine object exceeds its byte limit");
			}
			return object.bytes();
		},
	};
}

export function createCloudflareImagesDecoder(images: ImagesBinding): DisplayMediaDecoder {
	return {
		async decode(bytes, limits) {
			if (limits.signal.aborted) throw new Error("display media decoding was aborted");
			assertSingleFrameImage(bytes);
			const info = await images.info(new Blob([bytes]).stream());
			if (!("width" in info) || !("height" in info)) {
				throw new Error("display media decoder rejected a non-raster image");
			}
			const transformed = await images
				.input(new Blob([bytes]).stream())
				.transform({ width: 1, height: 1, fit: "contain" })
				.output({ format: "image/png", anim: false });
			await drainBoundedStream(transformed.image(), 1024 * 1024, limits.signal);
			return {
				mimeType: normalizeImageFormat(info.format),
				width: info.width,
				height: info.height,
				frames: 1,
			};
		},
	};
}

export function parsePinnedHttpResponse(bytes: Uint8Array): ParsedPinnedHttpResponse {
	const headerEnd = findSequence(bytes, HEADER_END, 0);
	if (headerEnd === -1 || headerEnd > MAX_HEADER_BYTES) {
		throw new Error("pinned HTTPS response headers are invalid or too large");
	}
	const headerText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
		bytes.subarray(0, headerEnd),
	);
	const lines = headerText.split("\r\n");
	const statusMatch = STATUS_LINE_RE.exec(lines.shift() ?? "");
	if (!statusMatch) throw new Error("pinned HTTPS response status line is invalid");
	const status = Number(statusMatch[1]);
	const headers = new Headers();
	const rawHeaders = new Map<string, string[]>();
	for (const line of lines) {
		if (FOLDED_HEADER_RE.test(line)) {
			throw new Error("pinned HTTPS response uses folded headers");
		}
		const separator = line.indexOf(":");
		if (separator < 1) throw new Error("pinned HTTPS response header is invalid");
		const name = line.slice(0, separator);
		const value = line.slice(separator + 1).trim();
		if (!HEADER_NAME_RE.test(name) || containsInvalidHeaderValue(value)) {
			throw new Error("pinned HTTPS response header is invalid");
		}
		const normalized = name.toLowerCase();
		const values = rawHeaders.get(normalized) ?? [];
		values.push(value);
		rawHeaders.set(normalized, values);
		headers.append(name, value);
	}
	const contentEncoding = rawHeaders.get("content-encoding");
	if (
		contentEncoding &&
		(contentEncoding.length !== 1 || contentEncoding[0]?.toLowerCase() !== "identity")
	) {
		throw new Error("pinned HTTPS response content encoding is unsupported");
	}
	const contentLength = rawHeaders.get("content-length");
	const transferEncoding = rawHeaders.get("transfer-encoding");
	if (contentLength && transferEncoding) {
		throw new Error("pinned HTTPS response framing is ambiguous");
	}
	const bodyBytes = bytes.subarray(headerEnd + HEADER_END.length);
	let body: Uint8Array;
	if (transferEncoding) {
		if (transferEncoding.length !== 1 || transferEncoding[0]?.toLowerCase() !== "chunked") {
			throw new Error("pinned HTTPS response transfer encoding is unsupported");
		}
		body = decodeChunkedBody(bodyBytes);
	} else if (contentLength) {
		if (contentLength.length !== 1 || !CONTENT_LENGTH_RE.test(contentLength[0]!)) {
			throw new Error("pinned HTTPS response content length is invalid");
		}
		const length = Number(contentLength[0]);
		if (!Number.isSafeInteger(length) || bodyBytes.byteLength !== length) {
			throw new Error("pinned HTTPS response body length does not match its framing");
		}
		body = new Uint8Array(bodyBytes);
	} else {
		body = new Uint8Array(bodyBytes);
	}
	return { status, headers, body };
}

function buildHttpRequest(url: URL, headers: Readonly<Record<string, string>>): Uint8Array {
	const authority = url.port ? `${url.hostname}:${url.port}` : url.hostname;
	const lines = [
		`GET ${url.pathname}${url.search} HTTP/1.1`,
		`Host: ${authority}`,
		"Connection: close",
		"Accept-Encoding: identity",
	];
	for (const [name, value] of Object.entries(headers)) {
		if (!HEADER_NAME_RE.test(name) || containsInvalidHeaderValue(value)) {
			throw new TypeError("display media request header is invalid");
		}
		const normalized = name.toLowerCase();
		if (normalized === "host" || normalized === "connection" || normalized === "accept-encoding") {
			continue;
		}
		lines.push(`${name}: ${value}`);
	}
	return new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n`);
}

async function readSocketResponse(socket: Socket, signal: AbortSignal): Promise<Uint8Array> {
	const reader = socket.readable.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const next = await abortable(reader.read(), signal, () => socket.close());
			if (next.done) break;
			if (!(next.value instanceof Uint8Array)) {
				throw new TypeError("pinned HTTPS socket returned non-byte data");
			}
			total += next.value.byteLength;
			if (total > MAX_SOCKET_RESPONSE_BYTES) {
				throw new RangeError("pinned HTTPS response exceeds its byte limit");
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function decodeChunkedBody(bytes: Uint8Array): Uint8Array {
	const chunks: Uint8Array[] = [];
	let offset = 0;
	let total = 0;
	for (;;) {
		const lineEnd = findSequence(bytes, CRLF, offset);
		if (lineEnd === -1 || lineEnd - offset > 128) {
			throw new Error("chunked response size line is invalid");
		}
		const sizeLine = new TextDecoder().decode(bytes.subarray(offset, lineEnd));
		const sizeText = sizeLine.split(";", 1)[0] ?? "";
		if (!CHUNK_SIZE_RE.test(sizeText)) throw new Error("chunked response size is invalid");
		const size = Number.parseInt(sizeText, 16);
		if (!Number.isSafeInteger(size)) throw new Error("chunked response size is invalid");
		offset = lineEnd + CRLF.length;
		if (size === 0) {
			if (
				offset + CRLF.length !== bytes.length ||
				bytes[offset] !== 13 ||
				bytes[offset + 1] !== 10
			) {
				throw new Error("chunked response trailer is invalid");
			}
			break;
		}
		if (offset + size + CRLF.length > bytes.length) {
			throw new Error("chunked response body is truncated");
		}
		const chunk = bytes.subarray(offset, offset + size);
		if (bytes[offset + size] !== 13 || bytes[offset + size + 1] !== 10) {
			throw new Error("chunked response delimiter is invalid");
		}
		chunks.push(new Uint8Array(chunk));
		total += size;
		offset += size + CRLF.length;
	}
	const body = new Uint8Array(total);
	let bodyOffset = 0;
	for (const chunk of chunks) {
		body.set(chunk, bodyOffset);
		bodyOffset += chunk.byteLength;
	}
	return body;
}

function findSequence(bytes: Uint8Array, sequence: Uint8Array, start: number): number {
	outer: for (let offset = start; offset <= bytes.length - sequence.length; offset += 1) {
		for (let index = 0; index < sequence.length; index += 1) {
			if (bytes[offset + index] !== sequence[index]) continue outer;
		}
		return offset;
	}
	return -1;
}

async function drainBoundedStream(
	stream: ReadableStream<Uint8Array>,
	maximumBytes: number,
	signal: AbortSignal,
): Promise<void> {
	const reader = stream.getReader();
	let total = 0;
	try {
		for (;;) {
			if (signal.aborted) throw new Error("display media decoding was aborted");
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > maximumBytes) throw new RangeError("decoded preview exceeds its byte limit");
		}
	} finally {
		reader.releaseLock();
	}
}

function assertSingleFrameImage(bytes: Uint8Array): void {
	if (bytes.length >= 6 && new TextDecoder().decode(bytes.subarray(0, 6)).startsWith("GIF8")) {
		throw new Error("animated-capable GIF display media is not accepted");
	}
	if (isPng(bytes) && pngContainsChunk(bytes, "acTL")) {
		throw new Error("animated PNG display media is not accepted");
	}
	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
		for (let offset = 12; offset + 8 <= bytes.length;) {
			const kind = ascii(bytes, offset, 4);
			const length = readUint32Le(bytes, offset + 4);
			if (kind === "ANIM" || kind === "ANMF") {
				throw new Error("animated WebP display media is not accepted");
			}
			const next = offset + 8 + length + (length % 2);
			if (next <= offset || next > bytes.length) break;
			offset = next;
		}
	}
}

function isPng(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	);
}

function pngContainsChunk(bytes: Uint8Array, expected: string): boolean {
	for (let offset = 8; offset + 12 <= bytes.length;) {
		const length = readUint32Be(bytes, offset);
		const kind = ascii(bytes, offset + 4, 4);
		if (kind === expected) return true;
		const next = offset + 12 + length;
		if (next <= offset || next > bytes.length) return false;
		offset = next;
	}
	return false;
}

function normalizeImageFormat(value: string): string {
	const normalized = value.toLowerCase();
	if (normalized.startsWith("image/")) return normalized;
	switch (normalized) {
		case "png":
		case "jpeg":
		case "gif":
		case "webp":
			return `image/${normalized}`;
		case "jpg":
			return "image/jpeg";
		default:
			throw new Error("display media decoder returned an unsupported format");
	}
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
	return new TextDecoder("latin1").decode(bytes.subarray(offset, offset + length));
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
	if (offset + 4 > bytes.length) return Number.MAX_SAFE_INTEGER;
	return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
	if (offset + 4 > bytes.length) return Number.MAX_SAFE_INTEGER;
	return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function hexToBytes(value: string): Uint8Array {
	if (!SHA256_HEX_RE.test(value)) throw new TypeError("media SHA-256 digest is invalid");
	return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
		Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
	);
}

interface MediaClaim {
	objectKey: string;
	sha256: string;
	ready: boolean;
}

type MediaStoreInput = Parameters<MediaContentStore["put"]>[0];

async function readMediaClaim(db: D1Database, idempotencyKey: string): Promise<MediaClaim | null> {
	const row = await db
		.prepare(
			`SELECT object_key, sha256, ready FROM media_quarantine_objects
			 WHERE idempotency_key = ?`,
		)
		.bind(idempotencyKey)
		.first<{ object_key: string; sha256: string; ready: number }>();
	return row ? { objectKey: row.object_key, sha256: row.sha256, ready: row.ready === 1 } : null;
}

function settledMediaClaim(
	claim: MediaClaim,
	expectedSha256: string,
	contentAddress: string,
): { contentRef: string; contentAddress: string } {
	assertMediaClaimMatches(claim, expectedSha256);
	if (!claim.ready) throw new Error("display media storage claim is still pending");
	return { contentRef: `${R2_CONTENT_REF_PREFIX}${claim.objectKey}`, contentAddress };
}

function assertMediaClaimMatches(claim: MediaClaim, expectedSha256: string): void {
	if (claim.sha256 !== expectedSha256) {
		throw new TypeError("display media idempotency key is bound to different bytes");
	}
}

function storedMediaMatches(object: R2Object | null, input: MediaStoreInput): boolean {
	return (
		object?.size === input.bytes.byteLength &&
		object.checksums.sha256 !== undefined &&
		bytesToHex(new Uint8Array(object.checksums.sha256)) === input.sha256 &&
		object.httpMetadata?.contentType === input.mimeType &&
		object.customMetadata?.sha256 === input.sha256 &&
		object.customMetadata.width === String(input.width) &&
		object.customMetadata.height === String(input.height) &&
		object.customMetadata.frames === String(input.frames)
	);
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function containsInvalidHeaderValue(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0)!;
		if (code === 0 || code === 10 || code === 13) return true;
	}
	return false;
}

async function abortable<T>(
	operation: Promise<T>,
	signal: AbortSignal,
	onAbort: () => void | Promise<void>,
): Promise<T> {
	if (signal.aborted) throw new Error("pinned HTTPS request was aborted");
	let abort: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		abort = () => {
			void onAbort();
			reject(new Error("pinned HTTPS request was aborted"));
		};
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		return await Promise.race([operation, aborted]);
	} finally {
		if (abort) signal.removeEventListener("abort", abort);
	}
}
