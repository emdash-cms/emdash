/**
 * In-memory package assembly for small packages (fixtures, tests, tools):
 * feed records in package order and blobs in any order, then `finish` writes
 * the index chunks and the manifest. The server-side exporter works in
 * bounded steps instead and does not use this.
 */

import { TransferError } from "../errors.js";
import { compareUtf16 } from "../format/canonical.js";
import { sha256Hex, type Sha256Digest } from "../format/digest.js";
import { KIND_FEATURE, requiredFeaturesFor, type SitePackageFeature } from "../format/features.js";
import {
	compareStreamOrder,
	recordKindIndex,
	type RecordKind,
	type SitePackageRecord,
} from "../format/kinds.js";
import { TRANSFER_LIMITS } from "../format/limits.js";
import type { PackageFileEntry, SitePackageManifest } from "../format/manifest.js";
import { encodeRecordLine } from "../format/records.js";
import type { ExportTransformation } from "../format/transformations.js";
import {
	SITE_PACKAGE_FORMAT,
	SITE_PACKAGE_FORMAT_VERSION,
	SITE_PACKAGE_PROFILE,
} from "../format/version.js";
import type { StagedPackageWriter } from "./package.js";

const encoder = new TextEncoder();

export interface PackageMetadata {
	packageId: string;
	originSiteId: string;
	createdAt: string;
	createdByEmDashVersion: string;
	defaultLocale: string;
	/** Features beyond those implied by the records (e.g. an empty `comments`). */
	extraFeatures?: readonly SitePackageFeature[];
	transformations?: readonly ExportTransformation[];
	fenceAttempts?: number;
}

export interface AssembledPackage {
	manifest: SitePackageManifest;
	digest: Sha256Digest;
}

interface PendingChunk {
	kind: RecordKind;
	lines: string[];
	bytes: number;
	records: SitePackageRecord[];
}

export class PackageAssembler {
	readonly #writer: StagedPackageWriter;
	readonly #files: PackageFileEntry[] = [];
	readonly #counts = new Map<RecordKind, { count: number; chunks: number }>();
	readonly #blobs = new Map<string, number>();
	readonly #locales = new Set<string>();
	#hasTrash = false;
	#pending: PendingChunk | null = null;
	#lastKind: RecordKind | null = null;
	#lastKey: { id: string; depth?: number } | null = null;
	#finished = false;

	constructor(writer: StagedPackageWriter) {
		this.#writer = writer;
	}

	/**
	 * Add the next record. Kinds must arrive in `RECORD_KINDS` order and
	 * records within a kind in stream order; pass `depth` for topological kinds.
	 */
	async addRecord(record: SitePackageRecord, options: { depth?: number } = {}): Promise<void> {
		this.assertOpen();
		const kind = record.kind;
		if (this.#lastKind !== null && recordKindIndex(kind) < recordKindIndex(this.#lastKind)) {
			throw new TransferError("TRANSFER_RECORD_INVALID", "Record kinds out of package order", {
				detail: { kind },
			});
		}
		const key = { id: record.id, depth: options.depth };
		if (
			this.#lastKind === kind &&
			this.#lastKey &&
			compareStreamOrder(kind, this.#lastKey, key) >= 0
		) {
			throw new TransferError("TRANSFER_RECORD_INVALID", "Records out of stream order", {
				detail: { kind, id: record.id },
			});
		}
		if (this.#lastKind !== kind) await this.flush();
		this.#lastKind = kind;
		this.#lastKey = key;

		if ("locale" in record && typeof record.locale === "string") this.#locales.add(record.locale);
		if (record.kind === "entry" && record.deletedAt !== undefined) this.#hasTrash = true;

		const line = encodeRecordLine(record);
		const lineBytes = encoder.encode(line).byteLength + 1;
		const pending = this.#pending;
		if (
			pending &&
			(pending.lines.length >= TRANSFER_LIMITS.chunkRecords ||
				pending.bytes + lineBytes > TRANSFER_LIMITS.chunkBytes)
		) {
			await this.flush();
		}
		this.#pending ??= { kind, lines: [], bytes: 0, records: [] };
		this.#pending.lines.push(line);
		this.#pending.bytes += lineBytes;
		this.#pending.records.push(record);
	}

	/** Store a blob (deduplicated by digest); returns its hex SHA-256. */
	async addBlob(bytes: Uint8Array): Promise<string> {
		this.assertOpen();
		const sha256 = await sha256Hex(bytes);
		if (!this.#blobs.has(sha256)) {
			this.#files.push(await this.#writer.writeBlob(sha256, bytes, bytes.byteLength));
			this.#blobs.set(sha256, bytes.byteLength);
		}
		return sha256;
	}

	async finish(metadata: PackageMetadata): Promise<AssembledPackage> {
		this.assertOpen();
		await this.flush();
		this.#finished = true;

		const features = new Set<SitePackageFeature>(metadata.extraFeatures ?? []);
		for (const kind of this.#counts.keys()) features.add(KIND_FEATURE[kind]);
		if (this.#blobs.size > 0) features.add("media");
		if (this.#locales.size > 1) features.add("i18n");
		if (this.#hasTrash) features.add("trash");
		const featureList = [...features].toSorted(compareUtf16);

		const files = this.#files.toSorted((a, b) => compareUtf16(a.path, b.path));
		const chunks: PackageFileEntry[][] = [];
		let current: PackageFileEntry[] = [];
		let currentBytes = 0;
		for (const entry of files) {
			const size = encoder.encode(JSON.stringify(entry)).byteLength + 1;
			if (
				current.length >= TRANSFER_LIMITS.chunkRecords ||
				(current.length > 0 && currentBytes + size > TRANSFER_LIMITS.chunkBytes)
			) {
				chunks.push(current);
				current = [];
				currentBytes = 0;
			}
			current.push(entry);
			currentBytes += size;
		}
		if (current.length > 0) chunks.push(current);
		const index = [];
		for (const [seq, entries] of chunks.entries()) {
			index.push(await this.#writer.writeIndexChunk(seq, entries));
		}

		const locales = new Set(this.#locales);
		locales.add(metadata.defaultLocale);
		const manifest: SitePackageManifest = {
			format: SITE_PACKAGE_FORMAT,
			formatVersion: SITE_PACKAGE_FORMAT_VERSION,
			packageId: metadata.packageId,
			originSiteId: metadata.originSiteId,
			createdAt: metadata.createdAt,
			createdByEmDashVersion: metadata.createdByEmDashVersion,
			profile: SITE_PACKAGE_PROFILE,
			features: featureList,
			requiredFeatures: requiredFeaturesFor(featureList),
			locales: {
				default: metadata.defaultLocale,
				used: [...locales].toSorted(compareUtf16),
			},
			records: Object.fromEntries(this.#counts),
			media: {
				count: this.#blobs.size,
				totalBytes: [...this.#blobs.values()].reduce((sum, bytes) => sum + bytes, 0),
			},
			files: {
				count: files.length,
				totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
			},
			index,
			transformations: (metadata.transformations ?? []).toSorted(
				(a, b) => compareUtf16(a.code, b.code) || compareUtf16(a.kind, b.kind),
			),
			fence: { attempts: metadata.fenceAttempts ?? 1 },
		};
		const digest = await this.#writer.writeManifest(manifest);
		return { manifest, digest };
	}

	private async flush(): Promise<void> {
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = null;
		const summary = this.#counts.get(pending.kind) ?? { count: 0, chunks: 0 };
		const entry = await this.#writer.writeRecordChunk(
			pending.kind,
			summary.chunks,
			pending.records,
		);
		this.#files.push(entry);
		this.#counts.set(pending.kind, {
			count: summary.count + pending.records.length,
			chunks: summary.chunks + 1,
		});
	}

	private assertOpen(): void {
		if (this.#finished) throw new Error("Package assembler already finished");
	}
}
