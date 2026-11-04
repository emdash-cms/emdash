/**
 * The `.emdash` single-file container: an uncompressed tar of the package
 * files, `manifest.json` first. The container is transport only — the package
 * digest covers the manifest, which pins every file — so these helpers never
 * need to trust the archive: every entry must be a regular file at a valid
 * package path, appear once, and carry exactly its declared size.
 *
 * Runs in browsers, Node, and Workers (web streams only).
 */

import { createTarDecoder, createTarPacker } from "modern-tar";

import { TransferError } from "../errors.js";
import { TRANSFER_LIMITS } from "../format/limits.js";
import { MANIFEST_PATH, parsePackagePath, type PackagePath } from "../format/paths.js";

export const SITE_PACKAGE_FILE_EXTENSION = ".emdash";
export const SITE_PACKAGE_MEDIA_TYPE = "application/x-tar";

/** Upper bound on archive entries: every indexed file, the index chunks, and the manifest. */
const MAX_ENTRIES = TRANSFER_LIMITS.totalFiles + TRANSFER_LIMITS.indexChunks + 1;

const DIRECTORY_ENTRY_PATTERN = /^(?:index|media|records(?:\/[a-z_]+)?)\/?$/;
const FIXED_MTIME = new Date(0);

function containerError(message: string, detail?: Record<string, string | number>): TransferError {
	return new TransferError("TRANSFER_CONTAINER_INVALID", message, detail ? { detail } : {});
}

export interface PackageFileSource {
	path: string;
	bytes: number;
	body: () =>
		| Promise<ReadableStream<Uint8Array> | Uint8Array>
		| ReadableStream<Uint8Array>
		| Uint8Array;
}

function toStream(body: ReadableStream<Uint8Array> | Uint8Array): ReadableStream<Uint8Array> {
	if (!(body instanceof Uint8Array)) return body;
	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (body.byteLength > 0) controller.enqueue(body);
			controller.close();
		},
	});
}

function sizeGuard(path: string, expected: number): TransformStream<Uint8Array, Uint8Array> {
	let seen = 0;
	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			seen += chunk.byteLength;
			if (seen > expected) throw containerError("Entry is larger than declared", { path });
			controller.enqueue(chunk);
		},
		flush() {
			if (seen !== expected) throw containerError("Entry is smaller than declared", { path });
		},
	});
}

/**
 * Stream a container from package files. `manifest.json` must come first;
 * every path must be a valid package path and appear once, and each body must
 * produce exactly `bytes` bytes. Entries get a fixed mtime and mode so the
 * same files always produce the same archive bytes.
 */
export function packSitePackage(
	files: AsyncIterable<PackageFileSource> | Iterable<PackageFileSource>,
): ReadableStream<Uint8Array> {
	const { readable, controller } = createTarPacker();
	void (async () => {
		const seen = new Set<string>();
		try {
			for await (const file of files) {
				if (seen.size === 0 && file.path !== MANIFEST_PATH) {
					throw containerError("The manifest must be the first entry");
				}
				if (!parsePackagePath(file.path)) {
					throw containerError("Invalid package path", { path: file.path });
				}
				if (seen.has(file.path))
					throw containerError("Duplicate package path", { path: file.path });
				if (seen.size >= MAX_ENTRIES) throw containerError("Too many entries");
				if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
					throw containerError("Invalid entry size", { path: file.path });
				}
				seen.add(file.path);
				const entry = controller.add({
					name: file.path,
					size: file.bytes,
					type: "file",
					mode: 0o644,
					mtime: FIXED_MTIME,
				});
				await toStream(await file.body())
					.pipeThrough(sizeGuard(file.path, file.bytes))
					.pipeTo(entry);
			}
			if (seen.size === 0) throw containerError("The manifest must be the first entry");
			controller.finalize();
		} catch (error) {
			controller.error(error);
		}
	})();
	return readable;
}

export interface UnpackedPackageFile {
	path: string;
	parsed: PackagePath;
	bytes: number;
	body: ReadableStream<Uint8Array>;
}

export interface UnpackOptions {
	/** Declared size for a path (from the manifest/index), checked against the entry header. */
	expectedBytes?: (path: string) => number | undefined;
}

/**
 * Read a container entry by entry. `onFile` receives each file in archive
 * order and may read its body; an unread body is skipped. If `onFile` takes a
 * reader it must read the body to the end or release the lock.
 * Rejects symlinks, hard links, and other non-file entries; paths that are
 * not package paths (absolute, `..`, anything undeclared by the format);
 * duplicates; a first entry other than `manifest.json`; and size mismatches.
 * Directory entries for the package's own directories are skipped.
 */
export async function unpackSitePackage(
	archive: ReadableStream<Uint8Array>,
	onFile: (file: UnpackedPackageFile) => Promise<void>,
	options: UnpackOptions = {},
): Promise<{ files: number }> {
	const seen = new Set<string>();
	let callbackError: unknown;
	const entries = archive.pipeThrough(createTarDecoder({ strict: true }));
	const reader = entries.getReader();
	try {
		for (;;) {
			const { done, value: entry } = await reader.read();
			if (done) break;
			const { header } = entry;
			const type = header.type ?? "file";
			const name = header.name.startsWith("./") ? header.name.slice(2) : header.name;

			if (type === "directory" && DIRECTORY_ENTRY_PATTERN.test(name)) {
				await entry.body.cancel();
				continue;
			}
			if (type !== "file") {
				await entry.body.cancel();
				throw containerError("Container entries must be regular files", { path: name });
			}
			const parsed = parsePackagePath(name);
			if (!parsed) {
				await entry.body.cancel();
				throw containerError("Invalid package path", { path: name.slice(0, 256) });
			}
			if (seen.size === 0 && parsed.type !== "manifest") {
				await entry.body.cancel();
				throw containerError("The manifest must be the first entry");
			}
			if (seen.has(name)) {
				await entry.body.cancel();
				throw containerError("Duplicate package path", { path: name });
			}
			if (seen.size >= MAX_ENTRIES) {
				await entry.body.cancel();
				throw containerError("Too many entries");
			}
			const expected = options.expectedBytes?.(name);
			if (expected !== undefined && expected !== header.size) {
				await entry.body.cancel();
				throw containerError("Entry size does not match the declared size", { path: name });
			}
			if (parsed.type === "manifest" && header.size > TRANSFER_LIMITS.manifestBytes) {
				await entry.body.cancel();
				throw new TransferError("TRANSFER_LIMIT_EXCEEDED", "Manifest is too large");
			}
			seen.add(name);

			const body = entry.body.pipeThrough(sizeGuard(name, header.size));
			let consumed = false;
			const tracked = body.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					flush() {
						consumed = true;
					},
				}),
			);
			try {
				await onFile({ path: name, parsed, bytes: header.size, body: tracked });
			} catch (error) {
				callbackError = error;
				await tracked.cancel().catch(() => undefined);
				throw error;
			}
			if (!consumed) {
				if (tracked.locked) {
					throw containerError("An entry body was left locked without being read", {
						path: name,
					});
				}
				await tracked.cancel();
			}
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		if (error === callbackError || error instanceof TransferError) throw error;
		throw new TransferError("TRANSFER_CONTAINER_INVALID", "Container could not be read", {
			cause: error,
		});
	} finally {
		reader.releaseLock();
	}
	if (seen.size === 0) throw containerError("The manifest must be the first entry");
	return { files: seen.size };
}

/** Buffer every file of a small container into memory (tests, small tools). */
export async function readSitePackageArchive(
	archive: ReadableStream<Uint8Array> | Uint8Array,
	options: UnpackOptions & { maxTotalBytes?: number } = {},
): Promise<Map<string, Uint8Array>> {
	const files = new Map<string, Uint8Array>();
	const maxTotal = options.maxTotalBytes ?? 256 * 1024 * 1024;
	let total = 0;
	await unpackSitePackage(
		toStream(archive),
		async (file) => {
			total += file.bytes;
			if (total > maxTotal) {
				throw new TransferError("TRANSFER_LIMIT_EXCEEDED", "Container is too large to buffer");
			}
			files.set(file.path, new Uint8Array(await new Response(file.body).arrayBuffer()));
		},
		options,
	);
	return files;
}
