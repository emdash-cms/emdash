/**
 * Byte-level access to one operation's staging area.
 */

import type { DownloadResult, Storage } from "../../storage/types.js";
import { TransferError, isTransferError } from "../errors.js";
import { createHashingStream, createSha256 } from "../format/digest.js";
import { stagingAuxKey, stagingKey, type StagingAuxFile } from "./keys.js";

type FixedLengthStreamConstructor = new (
	expectedLength: number | bigint,
) => TransformStream<ArrayBufferView | ArrayBuffer, Uint8Array>;

declare const FixedLengthStream: FixedLengthStreamConstructor | undefined;

export interface ExpectedFile {
	bytes: number;
	/** Lowercase hex SHA-256. */
	sha256: string;
}

export interface PutVerifiedOptions {
	contentType?: string;
	/**
	 * Called before deleting the object after a failed upload; return true to
	 * keep it (the path was already verified by another upload).
	 */
	keepExistingOnFailure?: () => Promise<boolean>;
}

const PACKAGE_CONTENT_TYPE = "application/octet-stream";

function oversizeError(): TransferError {
	return new TransferError("TRANSFER_FILE_SIZE_MISMATCH", "File is larger than declared");
}

function toStream(body: ReadableStream<Uint8Array> | Uint8Array): ReadableStream<Uint8Array> {
	if (body instanceof Uint8Array) {
		return new ReadableStream<Uint8Array>({
			start(controller) {
				if (body.byteLength > 0) controller.enqueue(body);
				controller.close();
			},
		});
	}
	return body;
}

/**
 * Stream `body` into `key`, hashing and counting as it goes. The object is
 * kept only if exactly `expected.bytes` bytes with digest `expected.sha256`
 * were written; otherwise it is deleted and `TRANSFER_FILE_SIZE_MISMATCH` or
 * `TRANSFER_FILE_DIGEST_MISMATCH` is thrown. Where the runtime provides
 * `FixedLengthStream` (workerd), the upload is wrapped in one so R2 receives
 * a known length.
 *
 * Callers staging a package file must check its staged-files row first and
 * refuse the upload when it is already `verified` and its object still
 * matches, and must pass `keepExistingOnFailure` returning true once the row
 * is verified: a failed retry or concurrent upload of the same path must not
 * delete the object a successful upload stored. A failing upload that
 * already overwrote the object can still leave bad bytes behind a verified
 * row, so readers verify sizes and digests again when they read staged
 * files, and a later upload of that path replaces the bad object.
 */
export async function putVerified(
	storage: Storage,
	key: string,
	body: ReadableStream<Uint8Array> | Uint8Array,
	expected: ExpectedFile,
	options: PutVerifiedOptions = {},
): Promise<void> {
	const discard = async () => {
		if (options.keepExistingOnFailure && (await options.keepExistingOnFailure())) return;
		await storage.delete(key).catch(() => undefined);
	};
	if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 0) {
		throw new TransferError("TRANSFER_FILE_SIZE_MISMATCH", "Invalid declared size");
	}
	const hasher = await createSha256();
	const hashing = createHashingStream(hasher, {
		maxBytes: expected.bytes,
		onLimitExceeded: oversizeError,
	});
	let stream = toStream(body).pipeThrough(hashing.stream);
	if (typeof FixedLengthStream !== "undefined") {
		stream = stream.pipeThrough(new FixedLengthStream(expected.bytes));
	}

	try {
		await storage.upload({
			key,
			body: stream,
			contentType: options.contentType ?? PACKAGE_CONTENT_TYPE,
		});
	} catch (error) {
		await discard();
		if (isTransferError(error)) throw error;
		const cause = findTransferError(error);
		if (cause) throw cause;
		if (hashing.bytes() !== expected.bytes) {
			throw new TransferError("TRANSFER_FILE_SIZE_MISMATCH", "File size does not match", {
				cause: error,
			});
		}
		throw new TransferError("TRANSFER_STORAGE_ERROR", "Failed to store file", { cause: error });
	}

	const digest = await hasher.digest();
	if (hashing.bytes() !== expected.bytes) {
		await discard();
		throw new TransferError("TRANSFER_FILE_SIZE_MISMATCH", "File size does not match", {
			detail: { expected: expected.bytes, actual: hashing.bytes() },
		});
	}
	if (digest !== expected.sha256) {
		await discard();
		throw new TransferError("TRANSFER_FILE_DIGEST_MISMATCH", "File digest does not match");
	}
}

function findTransferError(error: unknown): TransferError | null {
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
		if (current instanceof TransferError) return current;
		current = current.cause;
	}
	return null;
}

/** Read a whole stream, failing once it exceeds `maxBytes`. */
export async function readStreamBytes(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const parts: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				throw new TransferError("TRANSFER_LIMIT_EXCEEDED", "File exceeds its size limit", {
					detail: { limit: maxBytes },
				});
			}
			parts.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.byteLength;
	}
	return bytes;
}

/** One operation's staging area in `storage` under `prefix` (see keys.ts). */
export class TransferStage {
	constructor(
		readonly storage: Storage,
		readonly prefix: string,
	) {}

	keyFor(path: string): string {
		return stagingKey(this.prefix, path);
	}

	async putVerified(
		path: string,
		body: ReadableStream<Uint8Array> | Uint8Array,
		bytes: number,
		sha256: string,
		options: PutVerifiedOptions = {},
	): Promise<void> {
		await putVerified(this.storage, this.keyFor(path), body, { bytes, sha256 }, options);
	}

	async exists(path: string): Promise<boolean> {
		return this.storage.exists(this.keyFor(path));
	}

	async open(path: string): Promise<DownloadResult> {
		try {
			return await this.storage.download(this.keyFor(path));
		} catch (error) {
			throw new TransferError("TRANSFER_FILE_MISSING", "Staged file is missing", {
				detail: { path },
				cause: error,
			});
		}
	}

	async readBytes(path: string, maxBytes: number): Promise<Uint8Array> {
		const file = await this.open(path);
		return readStreamBytes(file.body, maxBytes);
	}

	async putAux(file: StagingAuxFile, content: string): Promise<void> {
		await this.storage.upload({
			key: stagingAuxKey(this.prefix, file),
			body: new TextEncoder().encode(content),
			contentType: "application/json",
		});
	}

	async readAux(file: StagingAuxFile, maxBytes: number): Promise<string | null> {
		const key = stagingAuxKey(this.prefix, file);
		if (!(await this.storage.exists(key))) return null;
		const download = await this.storage.download(key);
		return new TextDecoder().decode(await readStreamBytes(download.body, maxBytes));
	}

	/**
	 * Delete up to `limit` staged objects. Returns the number deleted; call
	 * again until it returns 0.
	 */
	async deleteSome(limit = 100): Promise<number> {
		const listing = await this.storage.list({ prefix: this.prefix, limit });
		for (const file of listing.files) await this.storage.delete(file.key);
		return listing.files.length;
	}
}
