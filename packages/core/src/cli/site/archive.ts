/**
 * Reading and writing `.emdash` site package files on disk.
 *
 * Reading never trusts the archive: every entry is hashed and checked
 * against the manifest and the index chunks it pins before anything is
 * uploaded, so a damaged or tampered package fails locally.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { Readable, Writable } from "node:stream";

import {
	packSitePackage,
	unpackSitePackage,
	type PackageFileSource,
	type UnpackedPackageFile,
} from "../../transfer/container/tar.js";
import { TransferError } from "../../transfer/errors.js";
import {
	createSha256,
	packageDigest,
	sha256Hex,
	type Sha256Digest,
} from "../../transfer/format/digest.js";
import {
	decodeUtf8,
	parseIndexLine,
	parseManifest,
	type PackageFileEntry,
	type SitePackageManifest,
} from "../../transfer/format/manifest.js";

export interface LocalPackageFile {
	bytes: number;
	sha256: string;
}

export interface ScannedSitePackage {
	manifestBytes: Uint8Array;
	manifest: SitePackageManifest;
	packageDigest: Sha256Digest;
	/** Every file except the manifest: index chunks, record chunks, media blobs. */
	files: Map<string, LocalPackageFile>;
	/** Index chunk path → the record and media paths it lists. */
	indexEntries: Map<string, string[]>;
	/** Record or media path → the index chunk that lists it. */
	indexOf: Map<string, string>;
	totalBytes: number;
}

/** Split an index chunk into its entries. */
export function parseIndexChunk(bytes: Uint8Array): PackageFileEntry[] {
	const text = decodeUtf8(bytes, "TRANSFER_MANIFEST_INVALID");
	if (text.length > 0 && !text.endsWith("\n")) {
		throw new TransferError("TRANSFER_MANIFEST_INVALID", "Index chunk must end with a newline");
	}
	return text
		.split("\n")
		.slice(0, -1)
		.map((line) => parseIndexLine(line));
}

export function openArchive(path: string): ReadableStream<Uint8Array> {
	return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
}

export async function readBody(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	return new Uint8Array(await new Response(body).arrayBuffer());
}

function mismatch(path: string, kind: "digest" | "size"): TransferError {
	return kind === "digest"
		? new TransferError("TRANSFER_FILE_DIGEST_MISMATCH", "File does not match its digest", {
				detail: { path },
			})
		: new TransferError("TRANSFER_FILE_SIZE_MISMATCH", "File does not have its declared size", {
				detail: { path },
			});
}

/** Check bytes against a declared size and digest. */
export async function assertFileMatches(
	path: string,
	bytes: Uint8Array,
	expected: LocalPackageFile,
): Promise<void> {
	if (bytes.byteLength !== expected.bytes) throw mismatch(path, "size");
	if ((await sha256Hex(bytes)) !== expected.sha256) throw mismatch(path, "digest");
}

async function hashBody(body: ReadableStream<Uint8Array>): Promise<LocalPackageFile> {
	const hasher = await createSha256();
	let bytes = 0;
	await body.pipeTo(
		new WritableStream<Uint8Array>({
			write(chunk) {
				bytes += chunk.byteLength;
				hasher.update(chunk);
			},
		}),
	);
	return { bytes, sha256: await hasher.digest() };
}

/** Whether the file at `diskPath` exists and has exactly the expected size and digest. */
export async function diskFileMatches(
	diskPath: string,
	expected: LocalPackageFile,
): Promise<boolean> {
	let info;
	try {
		info = await stat(diskPath);
	} catch {
		return false;
	}
	if (!info.isFile() || info.size !== expected.bytes) return false;
	return (await hashBody(openArchive(diskPath))).sha256 === expected.sha256;
}

/**
 * Stream `body` to `diskPath`, verifying it against the package file `path`
 * declares. The file appears at `diskPath` only once it is complete and
 * verified.
 */
export async function saveVerifiedFile(
	path: string,
	body: ReadableStream<Uint8Array>,
	expected: LocalPackageFile,
	diskPath: string,
): Promise<void> {
	const temporary = `${diskPath}.download`;
	const hasher = await createSha256();
	let bytes = 0;
	const verify = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			bytes += chunk.byteLength;
			if (bytes > expected.bytes) throw mismatch(path, "size");
			hasher.update(chunk);
			controller.enqueue(chunk);
		},
	});
	try {
		await body
			.pipeThrough(verify)
			.pipeTo(Writable.toWeb(createWriteStream(temporary)) as WritableStream<Uint8Array>);
		if (bytes !== expected.bytes) throw mismatch(path, "size");
		if ((await hasher.digest()) !== expected.sha256) throw mismatch(path, "digest");
		await rename(temporary, diskPath);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

/**
 * Read a package file end to end and verify it: the manifest, every index
 * chunk the manifest pins, and every file the index lists, each by size and
 * SHA-256. Fails with a `TransferError` naming the first bad path.
 */
export async function scanSitePackage(archivePath: string): Promise<ScannedSitePackage> {
	let manifestBytes: Uint8Array | undefined;
	let manifest: SitePackageManifest | undefined;
	const indexRefs = new Map<string, LocalPackageFile>();
	const declared = new Map<string, LocalPackageFile>();
	const indexEntries = new Map<string, string[]>();
	const indexOf = new Map<string, string>();
	const seen = new Map<string, LocalPackageFile>();

	await unpackSitePackage(
		openArchive(archivePath),
		async (file: UnpackedPackageFile) => {
			if (file.parsed.type === "manifest") {
				manifestBytes = await readBody(file.body);
				manifest = parseManifest(manifestBytes);
				for (const ref of manifest.index) {
					indexRefs.set(ref.path, { bytes: ref.bytes, sha256: ref.sha256 });
				}
				return;
			}
			if (file.parsed.type === "index") {
				const expected = indexRefs.get(file.path);
				if (!expected) {
					throw new TransferError("TRANSFER_FILE_NOT_DECLARED", "Index chunk is not listed", {
						detail: { path: file.path },
					});
				}
				if (file.bytes !== expected.bytes) throw mismatch(file.path, "size");
				const bytes = await readBody(file.body);
				await assertFileMatches(file.path, bytes, expected);
				const paths: string[] = [];
				for (const entry of parseIndexChunk(bytes)) {
					if (declared.has(entry.path)) {
						throw new TransferError("TRANSFER_MANIFEST_INVALID", "File is listed twice", {
							detail: { path: entry.path },
						});
					}
					declared.set(entry.path, { bytes: entry.bytes, sha256: entry.sha256 });
					indexOf.set(entry.path, file.path);
					paths.push(entry.path);
				}
				indexEntries.set(file.path, paths);
				seen.set(file.path, expected);
				return;
			}
			seen.set(file.path, await hashBody(file.body));
		},
		{
			expectedBytes: (path) => indexRefs.get(path)?.bytes ?? declared.get(path)?.bytes,
		},
	);

	if (!manifest || !manifestBytes) {
		throw new TransferError("TRANSFER_CONTAINER_INVALID", "The package has no manifest");
	}
	for (const [path, expected] of [...indexRefs, ...declared]) {
		const actual = seen.get(path);
		if (!actual) {
			throw new TransferError("TRANSFER_FILE_MISSING", "The package is missing a file", {
				detail: { path },
			});
		}
		if (actual.bytes !== expected.bytes) throw mismatch(path, "size");
		if (actual.sha256 !== expected.sha256) throw mismatch(path, "digest");
	}
	for (const path of seen.keys()) {
		if (!indexRefs.has(path) && !declared.has(path)) {
			throw new TransferError("TRANSFER_FILE_NOT_DECLARED", "File is not listed by the package", {
				detail: { path },
			});
		}
	}

	let totalBytes = manifestBytes.byteLength;
	for (const file of seen.values()) totalBytes += file.bytes;
	return {
		manifestBytes,
		manifest,
		packageDigest: await packageDigest(manifest),
		files: seen,
		indexEntries,
		indexOf,
		totalBytes,
	};
}

/**
 * Stream `files` into a package file at `outputPath`. Writes go to a
 * sibling `.partial` file that replaces `outputPath` only once the whole
 * archive is written; on failure the partial file is removed.
 */
export async function writeSitePackage(
	outputPath: string,
	files: AsyncIterable<PackageFileSource>,
): Promise<{ bytes: number }> {
	const partialPath = `${outputPath}.partial`;
	let bytes = 0;
	const counter = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			bytes += chunk.byteLength;
			controller.enqueue(chunk);
		},
	});
	const sink = Writable.toWeb(createWriteStream(partialPath)) as WritableStream<Uint8Array>;
	try {
		await packSitePackage(files).pipeThrough(counter).pipeTo(sink);
		await rename(partialPath, outputPath);
	} catch (error) {
		await rm(partialPath, { force: true });
		throw error;
	}
	return { bytes };
}
