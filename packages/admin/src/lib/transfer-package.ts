/**
 * Reading a `.emdash` site package in the browser and uploading it to an
 * import.
 *
 * A `.emdash` file is an uncompressed tar of the package files with
 * `manifest.json` first. The archive is streamed entry by entry from
 * `File.stream()`; only the entry being uploaded is held in memory. Every
 * check here is repeated by the server, which verifies each file's size and
 * SHA-256 against the manifest before accepting it.
 */

import { createTarDecoder } from "modern-tar";

import { isTerminalRequestError } from "./api/client.js";
import {
	createTransferImport,
	fetchTransferImportMissing,
	uploadTransferImportFile,
	type CreateImportResult,
	type MissingFile,
	type Sha256Digest,
	type TransferOperation,
	type TransferPage,
} from "./api/transfer.js";

export const SITE_PACKAGE_EXTENSION = ".emdash";

const MANIFEST_PATH = "manifest.json";
const INDEX_PATH_PATTERN = /^index\/\d{6}\.ndjson$/;
const RECORD_PATH_PATTERN = /^records\/[a-z_]+\/\d{6}\.ndjson$/;
const MEDIA_PATH_PATTERN = /^media\/[0-9a-f]{64}$/;
const DIRECTORY_ENTRY_PATTERN = /^(?:index|media|records(?:\/[a-z_]+)?)\/?$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export type PackagePathType = "manifest" | "index" | "records" | "media";

/** The package path grammar: anything else is not part of a site package. */
export function packagePathType(path: string): PackagePathType | null {
	if (path === MANIFEST_PATH) return "manifest";
	if (INDEX_PATH_PATTERN.test(path)) return "index";
	if (RECORD_PATH_PATTERN.test(path)) return "records";
	if (MEDIA_PATH_PATTERN.test(path)) return "media";
	return null;
}

export type PackageErrorReason =
	| "unreadable"
	| "manifest_first"
	| "manifest_invalid"
	| "not_a_file"
	| "invalid_path"
	| "duplicate_path"
	| "too_large"
	| "size_mismatch"
	| "digest_mismatch"
	| "different_package"
	| "export_changed"
	| "files_missing";

/**
 * An earlier import of the chosen package stopped after it started writing
 * to this site, so the site holds partial data and can't take a new import.
 */
export class EarlierImportWroteError extends Error {
	constructor(public readonly operation: TransferOperation) {
		super(`import ${operation.id} ${operation.state} after writing`);
		this.name = "EarlierImportWroteError";
	}
}

/** A problem with the chosen file, found before or while uploading it. */
export class SitePackageError extends Error {
	constructor(
		public readonly reason: PackageErrorReason,
		public readonly path?: string,
	) {
		super(path ? `${reason}: ${path}` : reason);
		this.name = "SitePackageError";
	}
}

export interface PackageLimits {
	manifestBytes: number;
	chunkBytes: number;
	maxBlobBytes: number;
}

function sizeLimit(type: PackagePathType, limits: PackageLimits): number {
	switch (type) {
		case "manifest":
			return limits.manifestBytes;
		case "media":
			return limits.maxBlobBytes;
		case "index":
		case "records":
			return limits.chunkBytes;
	}
}

export interface PackageEntry {
	path: string;
	type: PackagePathType;
	bytes: number;
	/** Read the whole entry. Only call it for entries that are needed. */
	read: () => Promise<Uint8Array<ArrayBuffer>>;
}

async function readAll(body: ReadableStream<Uint8Array>, expected: number, path: string) {
	const buffer = new Uint8Array(expected);
	const reader = body.getReader();
	let offset = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (offset + value.byteLength > expected) {
			await reader.cancel();
			throw new SitePackageError("size_mismatch", path);
		}
		buffer.set(value, offset);
		offset += value.byteLength;
	}
	if (offset !== expected) throw new SitePackageError("size_mismatch", path);
	return buffer;
}

/**
 * Stream a package archive entry by entry. Rejects non-file entries, paths
 * outside the package grammar, duplicates, a first entry other than
 * `manifest.json`, and entries larger than the site accepts. Entries whose
 * body `onEntry` does not read are skipped without buffering.
 */
export async function readSitePackage(
	file: Blob,
	limits: PackageLimits,
	onEntry: (entry: PackageEntry) => Promise<void>,
): Promise<void> {
	const seen = new Set<string>();
	const reader = file
		.stream()
		.pipeThrough(createTarDecoder({ strict: true }))
		.getReader();
	try {
		for (;;) {
			let next: ReadableStreamReadResult<{
				header: { name: string; size: number; type?: string };
				body: ReadableStream<Uint8Array>;
			}>;
			try {
				next = await reader.read();
			} catch {
				throw new SitePackageError("unreadable");
			}
			if (next.done) break;
			const { header, body } = next.value;
			const name = header.name.startsWith("./") ? header.name.slice(2) : header.name;
			const entryType = header.type ?? "file";

			if (entryType === "directory" && DIRECTORY_ENTRY_PATTERN.test(name)) {
				await body.cancel();
				continue;
			}
			if (entryType !== "file") {
				await body.cancel();
				throw new SitePackageError("not_a_file", name);
			}
			const type = packagePathType(name);
			if (!type) {
				await body.cancel();
				throw new SitePackageError("invalid_path", name.slice(0, 256));
			}
			if (seen.size === 0 && type !== "manifest") {
				await body.cancel();
				throw new SitePackageError("manifest_first");
			}
			if (seen.has(name)) {
				await body.cancel();
				throw new SitePackageError("duplicate_path", name);
			}
			if (header.size > sizeLimit(type, limits)) {
				await body.cancel();
				throw new SitePackageError("too_large", name);
			}
			seen.add(name);

			let consumed = false;
			await onEntry({
				path: name,
				type,
				bytes: header.size,
				read: () => {
					consumed = true;
					return readAll(body, header.size, name);
				},
			});
			if (!consumed) await body.cancel();
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
	if (seen.size === 0) throw new SitePackageError("manifest_first");
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `sha256(manifest bytes)`: the manifest is canonical JSON, so this is the package digest. */
export async function packageDigestOf(manifest: Uint8Array<ArrayBuffer>): Promise<Sha256Digest> {
	return `sha256:${await sha256Hex(manifest)}`;
}

export interface IndexEntry {
	path: string;
	bytes: number;
	sha256: string;
}

export function parseIndexChunk(bytes: Uint8Array, path: string): IndexEntry[] {
	const entries: IndexEntry[] = [];
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	for (const line of text.split("\n")) {
		if (line === "") continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new SitePackageError("manifest_invalid", path);
		}
		if (
			typeof value !== "object" ||
			value === null ||
			!("path" in value) ||
			!("bytes" in value) ||
			!("sha256" in value) ||
			typeof value.path !== "string" ||
			typeof value.bytes !== "number" ||
			typeof value.sha256 !== "string" ||
			!SHA256_HEX_PATTERN.test(value.sha256)
		) {
			throw new SitePackageError("manifest_invalid", path);
		}
		entries.push({ path: value.path, bytes: value.bytes, sha256: value.sha256 });
	}
	return entries;
}

export interface UploadProgress {
	phase: "reading" | "uploading";
	filesDone: number;
	filesTotal: number;
	bytesDone: number;
	bytesTotal: number;
}

export interface TransferUploadApi {
	createImport: (
		manifest: Uint8Array<ArrayBuffer>,
		idempotencyKey: string,
	) => Promise<CreateImportResult>;
	listMissing: (
		operationId: string,
		options: { cursor?: string },
	) => Promise<TransferPage<MissingFile>>;
	uploadFile: (
		operationId: string,
		path: string,
		body: Uint8Array<ArrayBuffer>,
		signal?: AbortSignal,
	) => Promise<unknown>;
}

const defaultApi: TransferUploadApi = {
	createImport: createTransferImport,
	listMissing: (operationId, options) => fetchTransferImportMissing(operationId, options),
	uploadFile: uploadTransferImportFile,
};

export interface UploadSitePackageOptions {
	file: Blob;
	limits: PackageLimits;
	/** Only accept this package; used when resuming an existing import. */
	expectedPackageDigest?: Sha256Digest | null;
	onProgress?: (progress: UploadProgress) => void;
	/** Called once the import exists, before any other file is uploaded. */
	onOperation?: (operation: TransferOperation) => void;
	signal?: AbortSignal;
	concurrency?: number;
	retries?: number;
	/** Delay before retry attempt `n` (1-based). */
	retryDelayMs?: (attempt: number) => number;
	api?: TransferUploadApi;
}

const ENDED_WITHOUT_RECEIPT = new Set(["failed", "cancelled", "abandoned", "expired"]);

/**
 * Create the import keyed by the package digest. The server returns an
 * earlier import of the same package for that key even when it has ended;
 * an ended import is then retried under a key derived from its ID, so the
 * same file can be imported again and a retried request still finds the
 * import it created.
 */
async function openImport(
	api: TransferUploadApi,
	manifest: Uint8Array<ArrayBuffer>,
	digest: Sha256Digest,
): Promise<CreateImportResult> {
	let created = await api.createImport(manifest, digest);
	while (ENDED_WITHOUT_RECEIPT.has(created.operation.state)) {
		if (created.operation.mutationStartedAt !== null) {
			throw new EarlierImportWroteError(created.operation);
		}
		created = await api.createImport(manifest, `${digest}/${created.operation.id}`);
	}
	return created;
}

const DEFAULT_CONCURRENCY = 3;
const STOP_READING = Symbol("stop reading");
const DEFAULT_RETRIES = 3;
/** Extra passes over the archive when files are declared after they were read. */
const MAX_PASSES = 3;

function defaultRetryDelay(attempt: number): number {
	return Math.min(1000 * 2 ** (attempt - 1), 8000);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

/**
 * Create (or reopen) the import for a package file and upload every file the
 * server still needs. Index chunks are uploaded first, as the archive lists
 * them, and each one declares the files it lists. Files are uploaded with
 * bounded concurrency and retried on transient failures. Returns the import
 * operation once nothing is missing.
 */
export async function uploadSitePackage(
	options: UploadSitePackageOptions,
): Promise<TransferOperation> {
	const api = options.api ?? defaultApi;
	const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
	const retries = options.retries ?? DEFAULT_RETRIES;
	const retryDelay = options.retryDelayMs ?? defaultRetryDelay;
	const { signal } = options;

	const needed = new Map<string, IndexEntry>();
	const progress: UploadProgress = {
		phase: "reading",
		filesDone: 0,
		filesTotal: 0,
		bytesDone: 0,
		bytesTotal: 0,
	};
	const report = () => options.onProgress?.({ ...progress });
	const need = (file: IndexEntry) => {
		if (needed.has(file.path)) return;
		needed.set(file.path, file);
		progress.filesTotal += 1;
		progress.bytesTotal += file.bytes;
	};

	let operation: TransferOperation | null = null;

	async function refreshMissing(operationId: string): Promise<void> {
		let cursor: string | undefined;
		do {
			const page = await api.listMissing(operationId, { cursor });
			for (const file of page.items) need(file);
			cursor = page.nextCursor;
		} while (cursor);
	}

	async function uploadWithRetry(
		operationId: string,
		file: IndexEntry,
		body: Uint8Array<ArrayBuffer>,
	) {
		for (let attempt = 0; ; attempt++) {
			signal?.throwIfAborted();
			try {
				await api.uploadFile(operationId, file.path, body, signal);
				return;
			} catch (error) {
				if (signal?.aborted || isTerminalRequestError(error) || attempt >= retries) throw error;
				await wait(retryDelay(attempt + 1), signal);
			}
		}
	}

	async function pass(): Promise<number> {
		const inFlight = new Set<Promise<void>>();
		let failure: unknown;
		let uploadedThisPass = 0;

		const track = (task: Promise<void>) => {
			const tracked: Promise<void> = task
				.catch((error: unknown) => {
					failure ??= error;
				})
				.finally(() => inFlight.delete(tracked));
			inFlight.add(tracked);
		};
		const drain = async () => {
			await Promise.all(inFlight);
			if (failure) throw failure;
		};

		const reading = readSitePackage(options.file, options.limits, async (entry) => {
			if (failure) throw failure;
			signal?.throwIfAborted();

			if (entry.type === "manifest") {
				if (operation) return;
				const manifest = await entry.read();
				const digest = await packageDigestOf(manifest);
				if (options.expectedPackageDigest && digest !== options.expectedPackageDigest) {
					throw new SitePackageError("different_package");
				}
				const created = await openImport(api, manifest, digest);
				operation = created.operation;
				options.onOperation?.(operation);
				for (const file of created.missing.items) need(file);
				if (created.missing.nextCursor) {
					await refreshMissing(operation.id);
				}
				if (operation.state !== "uploading") throw STOP_READING;
				progress.phase = "uploading";
				report();
				return;
			}

			const current = operation;
			if (!current || current.state !== "uploading") return;
			const file = needed.get(entry.path);
			if (!file) return;
			if (entry.bytes !== file.bytes) throw new SitePackageError("size_mismatch", entry.path);

			while (inFlight.size >= concurrency) {
				await Promise.race(inFlight);
				if (failure) throw failure;
			}

			const body = await entry.read();
			if ((await sha256Hex(body)) !== file.sha256) {
				throw new SitePackageError("digest_mismatch", entry.path);
			}

			const upload = (async () => {
				await uploadWithRetry(current.id, file, body);
				needed.delete(file.path);
				uploadedThisPass += 1;
				progress.filesDone += 1;
				progress.bytesDone += file.bytes;
				report();
			})();

			if (entry.type === "index") {
				await upload;
				for (const listed of parseIndexChunk(body, entry.path)) need(listed);
				report();
			} else {
				track(upload);
			}
		});
		try {
			await reading;
		} catch (error) {
			if (error !== STOP_READING) {
				await Promise.allSettled(inFlight);
				throw error;
			}
		}
		await drain();
		return uploadedThisPass;
	}

	for (let passes = 0; ; passes++) {
		const uploaded = await pass();
		const current = operation as TransferOperation | null;
		if (!current) throw new SitePackageError("manifest_first");
		if (current.state !== "uploading") return current;
		needed.clear();
		progress.filesTotal = progress.filesDone;
		progress.bytesTotal = progress.bytesDone;
		await refreshMissing(current.id);
		if (needed.size === 0) return current;
		if (uploaded === 0 || passes + 1 >= MAX_PASSES) {
			throw new SitePackageError("files_missing");
		}
		report();
	}
}
