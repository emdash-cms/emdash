/**
 * Downloading a complete export file by file and assembling the `.emdash`
 * archive in the browser.
 *
 * The archive matches the one the server streams from `exports/:id/archive`
 * and the one the CLI writes: `manifest.json` first, then the index chunks,
 * then every indexed file in index (path) order, each a regular tar entry
 * with mode 0644 and mtime 0. Every file is checked against the size and
 * SHA-256 the manifest or its index declares before it is written, and the
 * manifest itself against the export's package digest.
 */

import { createTarPacker } from "modern-tar";

import { isTerminalRequestError } from "./api/client.js";
import {
	fetchTransferExportFile,
	fetchTransferExportManifestBytes,
	type Sha256Digest,
} from "./api/transfer.js";
import {
	packageDigestOf,
	packagePathType,
	parseIndexChunk,
	sha256Hex,
	SitePackageError,
	type IndexEntry,
} from "./transfer-package.js";

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RETRIES = 3;
/** Downloaded-but-unwritten bytes allowed in flight; one larger file may exceed it. */
const PREFETCH_BYTES = 64 * 1024 * 1024;
const ENTRY_MODE = 0o644;
const ENTRY_MTIME = new Date(0);

export interface ExportDownloadApi {
	fetchManifest: (operationId: string, signal?: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;
	fetchFile: (
		operationId: string,
		path: string,
		signal?: AbortSignal,
	) => Promise<Uint8Array<ArrayBuffer>>;
}

const defaultApi: ExportDownloadApi = {
	fetchManifest: fetchTransferExportManifestBytes,
	fetchFile: fetchTransferExportFile,
};

export interface DownloadProgress {
	filesDone: number;
	filesTotal: number;
	bytesDone: number;
	bytesTotal: number;
}

export interface DownloadSitePackageOptions {
	operationId: string;
	/** The export's package digest; the downloaded manifest must match it. */
	packageDigest: Sha256Digest;
	/** Receives the archive bytes. Aborted if the download fails. */
	sink: WritableStream<Uint8Array>;
	onProgress?: (progress: DownloadProgress) => void;
	signal?: AbortSignal;
	concurrency?: number;
	retries?: number;
	/** Delay before retry attempt `n` (1-based). */
	retryDelayMs?: (attempt: number) => number;
	api?: ExportDownloadApi;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** The index chunks `manifest.json` declares, in order. */
function readManifestIndex(bytes: Uint8Array): IndexEntry[] {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new SitePackageError("manifest_invalid", "manifest.json");
	}
	if (!isRecord(value) || !Array.isArray(value.index)) {
		throw new SitePackageError("manifest_invalid", "manifest.json");
	}
	const index: IndexEntry[] = [];
	for (const ref of value.index) {
		if (
			!isRecord(ref) ||
			typeof ref.path !== "string" ||
			packagePathType(ref.path) !== "index" ||
			typeof ref.bytes !== "number" ||
			typeof ref.sha256 !== "string"
		) {
			throw new SitePackageError("manifest_invalid", "manifest.json");
		}
		index.push({ path: ref.path, bytes: ref.bytes, sha256: ref.sha256 });
	}
	return index;
}

/**
 * Download a complete export and write it to `sink` as a `.emdash` archive.
 * Files are fetched with bounded concurrency and written in package order;
 * transient failures are retried, while a file that does not match its
 * declared size or digest stops the download.
 */
export async function downloadSitePackage(
	options: DownloadSitePackageOptions,
): Promise<{ files: number; bytes: number }> {
	const api = options.api ?? defaultApi;
	const { operationId } = options;
	const stop = new AbortController();
	const stopFromCaller = () => stop.abort(options.signal?.reason);
	if (options.signal?.aborted) stopFromCaller();
	options.signal?.addEventListener("abort", stopFromCaller, { once: true });
	const signal = stop.signal;
	const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
	const retries = options.retries ?? DEFAULT_RETRIES;
	const retryDelay = options.retryDelayMs ?? defaultRetryDelay;

	async function withRetry<T>(task: () => Promise<T>): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			signal.throwIfAborted();
			try {
				return await task();
			} catch (error) {
				if (
					signal.aborted ||
					error instanceof SitePackageError ||
					isTerminalRequestError(error) ||
					attempt >= retries
				) {
					throw error;
				}
				await wait(retryDelay(attempt + 1), signal);
			}
		}
	}

	async function fetchVerified(file: IndexEntry): Promise<Uint8Array<ArrayBuffer>> {
		const bytes = await withRetry(() => api.fetchFile(operationId, file.path, signal));
		if (bytes.byteLength !== file.bytes) throw new SitePackageError("size_mismatch", file.path);
		if ((await sha256Hex(bytes)) !== file.sha256) {
			throw new SitePackageError("digest_mismatch", file.path);
		}
		return bytes;
	}

	const { readable, controller } = createTarPacker();
	let written = 0;
	const counted = readable.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, stream) {
				written += chunk.byteLength;
				stream.enqueue(chunk);
			},
		}),
	);
	const piping = counted.pipeTo(options.sink, { signal });
	piping.catch(() => undefined);

	async function addEntry(path: string, bytes: Uint8Array<ArrayBuffer>) {
		const entry = controller.add({
			name: path,
			size: bytes.byteLength,
			type: "file",
			mode: ENTRY_MODE,
			mtime: ENTRY_MTIME,
		});
		const writer = entry.getWriter();
		await writer.write(bytes);
		await writer.close();
	}

	const inFlight: Array<{ file: IndexEntry; bytes: Promise<Uint8Array<ArrayBuffer>> }> = [];
	try {
		const manifestBytes = await withRetry(() => api.fetchManifest(operationId, signal));
		if ((await packageDigestOf(manifestBytes)) !== options.packageDigest) {
			throw new SitePackageError("export_changed", "manifest.json");
		}
		const index = readManifestIndex(manifestBytes);

		const indexChunks: Array<{ path: string; bytes: Uint8Array<ArrayBuffer> }> = [];
		const files: IndexEntry[] = [];
		for (const ref of index) {
			const bytes = await fetchVerified(ref);
			indexChunks.push({ path: ref.path, bytes });
			for (const entry of parseIndexChunk(bytes, ref.path)) {
				const type = packagePathType(entry.path);
				if (type !== "records" && type !== "media") {
					throw new SitePackageError("manifest_invalid", ref.path);
				}
				files.push(entry);
			}
		}

		const progress: DownloadProgress = {
			filesDone: 0,
			filesTotal: files.length,
			bytesDone: 0,
			bytesTotal: files.reduce((sum, file) => sum + file.bytes, 0),
		};
		options.onProgress?.({ ...progress });

		await addEntry("manifest.json", manifestBytes);
		for (const chunk of indexChunks) await addEntry(chunk.path, chunk.bytes);

		let next = 0;
		let queuedBytes = 0;
		const fill = () => {
			while (next < files.length) {
				const file = files[next];
				if (!file) break;
				const room =
					inFlight.length === 0 ||
					(inFlight.length < concurrency && queuedBytes + file.bytes <= PREFETCH_BYTES);
				if (!room) break;
				const bytes = fetchVerified(file);
				bytes.catch(() => undefined);
				inFlight.push({ file, bytes });
				queuedBytes += file.bytes;
				next++;
			}
		};
		fill();
		while (inFlight.length > 0) {
			const head = inFlight.shift();
			if (!head) break;
			const bytes = await head.bytes;
			queuedBytes -= head.file.bytes;
			fill();
			await addEntry(head.file.path, bytes);
			progress.filesDone += 1;
			progress.bytesDone += bytes.byteLength;
			options.onProgress?.({ ...progress });
		}

		controller.finalize();
		await piping;
		return { files: 1 + indexChunks.length + files.length, bytes: written };
	} catch (error) {
		controller.error(error);
		stop.abort(error);
		await piping.catch(() => undefined);
		await options.sink.abort(error).catch(() => undefined);
		throw error;
	} finally {
		options.signal?.removeEventListener("abort", stopFromCaller);
	}
}
