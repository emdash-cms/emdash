/**
 * Staged package reader and writer.
 *
 * The writer stores package files under a {@link TransferStage}, returning
 * the index entry (size and digest) for each. The reader parses and validates
 * what is staged: the manifest, index chunks (checked against the digests the
 * manifest pins), record chunks (every line strictly validated), and blobs.
 */

import { TransferError } from "../errors.js";
import { canonicalJson } from "../format/canonical.js";
import { packageDigest, sha256Hex, type Sha256Digest } from "../format/digest.js";
import type { RecordKind, RecordOfKind } from "../format/kinds.js";
import { TRANSFER_LIMITS } from "../format/limits.js";
import {
	parseIndexLine,
	parseManifest,
	serializeManifest,
	type IndexChunkRef,
	type PackageFileEntry,
	type SitePackageManifest,
} from "../format/manifest.js";
import { indexChunkPath, MANIFEST_PATH, mediaBlobPath, recordChunkPath } from "../format/paths.js";
import {
	decodeRecordLine,
	encodeChunk,
	encodeRecordLine,
	splitChunkLines,
} from "../format/records.js";
import { readStreamBytes, TransferStage, type ExpectedFile } from "./stage.js";

const encoder = new TextEncoder();

export class StagedPackageWriter {
	constructor(readonly stage: TransferStage) {}

	/** Store bytes at a package path; returns its index entry (without `records`). */
	async writeFile(path: string, bytes: Uint8Array): Promise<PackageFileEntry> {
		const sha256 = await sha256Hex(bytes);
		await this.stage.putVerified(path, bytes, bytes.byteLength, sha256);
		return { path, bytes: bytes.byteLength, sha256 };
	}

	/** Encode and store one record chunk. Records must already be in stream order. */
	async writeRecordChunk<K extends RecordKind>(
		kind: K,
		seq: number,
		records: readonly RecordOfKind<K>[],
	): Promise<PackageFileEntry> {
		const path = recordChunkPath(kind, seq);
		for (const record of records) {
			if (record.kind !== kind) {
				throw new TransferError("TRANSFER_RECORD_INVALID", "Record kind does not match its chunk", {
					detail: { path, id: record.id },
				});
			}
		}
		const lines = records.map((record) => encodeRecordLine(record));
		const entry = await this.writeFile(path, encodeChunk(lines, path));
		return { ...entry, records: records.length };
	}

	/** Encode and store one index chunk. */
	async writeIndexChunk(seq: number, entries: readonly PackageFileEntry[]): Promise<IndexChunkRef> {
		const path = indexChunkPath(seq);
		const lines = entries.map((entry) => canonicalJson(entry));
		const file = await this.writeFile(path, encodeChunk(lines, path));
		return { path, bytes: file.bytes, sha256: file.sha256, entries: entries.length };
	}

	/** Store a media blob, verifying the declared size and digest as it streams. */
	async writeBlob(
		sha256: string,
		body: ReadableStream<Uint8Array> | Uint8Array,
		bytes: number,
	): Promise<PackageFileEntry> {
		const path = mediaBlobPath(sha256);
		await this.stage.putVerified(path, body, bytes, sha256);
		return { path, bytes, sha256 };
	}

	/** Store the manifest; returns its package digest. */
	async writeManifest(manifest: SitePackageManifest): Promise<Sha256Digest> {
		const text = serializeManifest(parseManifest(serializeManifest(manifest)));
		const bytes = encoder.encode(text);
		await this.stage.putVerified(MANIFEST_PATH, bytes, bytes.byteLength, await sha256Hex(bytes));
		return packageDigest(manifest);
	}
}

export interface StagedRecord<K extends RecordKind> {
	record: RecordOfKind<K>;
	/** Canonical line without newline; its SHA-256 is the record hash. */
	line: string;
	seq: number;
	/** Zero-based line number within the chunk. */
	index: number;
}

/** Size and digest a staged file must have when read, or null when it is not verified. */
export type StagedFileDigests = (path: string) => Promise<ExpectedFile | null>;

export class StagedPackageReader {
	#manifest: SitePackageManifest | undefined;

	/**
	 * With `digests`, every record chunk read is checked against the size and
	 * digest it was verified with, and a chunk that is not verified is missing.
	 */
	constructor(
		readonly stage: TransferStage,
		private readonly digests?: StagedFileDigests,
	) {}

	/** The parsed, validated manifest (read once). */
	async manifest(): Promise<SitePackageManifest> {
		if (!this.#manifest) {
			const bytes = await this.stage.readBytes(MANIFEST_PATH, TRANSFER_LIMITS.manifestBytes);
			this.#manifest = parseManifest(bytes);
		}
		return this.#manifest;
	}

	async digest(): Promise<Sha256Digest> {
		return packageDigest(await this.manifest());
	}

	/** Entries of one index chunk, verified against the digest the manifest pins. */
	async indexChunk(seq: number): Promise<PackageFileEntry[]> {
		const manifest = await this.manifest();
		const ref = manifest.index[seq];
		if (!ref) {
			throw new TransferError("TRANSFER_FILE_MISSING", "Index chunk is not declared", {
				detail: { seq },
			});
		}
		const bytes = await this.readVerified(ref.path, ref);
		const entries = splitChunkLines(bytes, ref.path).map((line) => parseIndexLine(line));
		if (entries.length !== ref.entries) {
			throw new TransferError("TRANSFER_MANIFEST_INVALID", "Index chunk entry count mismatch", {
				detail: { path: ref.path },
			});
		}
		return entries;
	}

	/** Every index entry in path order, starting at index chunk `fromSeq`. */
	async *index(fromSeq = 0): AsyncGenerator<{ seq: number; entry: PackageFileEntry }> {
		const manifest = await this.manifest();
		for (let seq = fromSeq; seq < manifest.index.length; seq++) {
			for (const entry of await this.indexChunk(seq)) yield { seq, entry };
		}
	}

	/**
	 * Records of one chunk, each strictly validated. Pass `expected` (from the
	 * index) to also verify the chunk's size and digest; otherwise the reader's
	 * `digests`, when it has them, supply it.
	 */
	async readChunk<K extends RecordKind>(
		kind: K,
		seq: number,
		expected?: ExpectedFile,
	): Promise<Array<StagedRecord<K>>> {
		const path = recordChunkPath(kind, seq);
		const file = expected ?? (await this.expectedFile(path));
		const bytes = file
			? await this.readVerified(path, file)
			: await this.stage.readBytes(path, TRANSFER_LIMITS.chunkBytes);
		return splitChunkLines(bytes, path).map((line, index) => {
			const decoded = decodeRecordLine(kind, line, { path, line: index + 1 });
			return { record: decoded.record, line: decoded.line, seq, index };
		});
	}

	/** Records of `kind` in stream order, starting at chunk `fromSeq`. */
	async *records<K extends RecordKind>(kind: K, fromSeq = 0): AsyncGenerator<StagedRecord<K>> {
		const manifest = await this.manifest();
		const chunks = manifest.records[kind]?.chunks ?? 0;
		for (let seq = fromSeq; seq < chunks; seq++) {
			yield* await this.readChunk(kind, seq);
		}
	}

	async blob(sha256: string): Promise<ReadableStream<Uint8Array>> {
		return (await this.stage.open(mediaBlobPath(sha256))).body;
	}

	private async expectedFile(path: string): Promise<ExpectedFile | undefined> {
		if (!this.digests) return undefined;
		const expected = await this.digests(path);
		if (!expected) {
			throw new TransferError("TRANSFER_FILE_MISSING", "Staged file is not verified", {
				detail: { path },
			});
		}
		return expected;
	}

	private async readVerified(path: string, expected: ExpectedFile): Promise<Uint8Array> {
		const file = await this.stage.open(path);
		let bytes: Uint8Array;
		try {
			bytes = await readStreamBytes(file.body, Math.max(expected.bytes, 0));
		} catch (error) {
			if (error instanceof TransferError && error.code === "TRANSFER_LIMIT_EXCEEDED") {
				throw new TransferError("TRANSFER_FILE_SIZE_MISMATCH", "Staged file size does not match", {
					detail: { path },
				});
			}
			throw error;
		}
		if (bytes.byteLength !== expected.bytes) {
			throw new TransferError("TRANSFER_FILE_SIZE_MISMATCH", "Staged file size does not match", {
				detail: { path },
			});
		}
		if ((await sha256Hex(bytes)) !== expected.sha256) {
			throw new TransferError(
				"TRANSFER_FILE_DIGEST_MISMATCH",
				"Staged file digest does not match",
				{
					detail: { path },
				},
			);
		}
		return bytes;
	}
}
