/**
 * Stages a (possibly broken) site package for an import operation. Built at
 * the file level rather than through `PackageAssembler`, so tests can stage
 * packages the assembler would refuse to produce: out-of-order or invalid
 * records, oversized lines, manifests with unknown features.
 */

import type { Kysely } from "kysely";

import type { Database } from "../../../../src/database/types.js";
import type { Storage } from "../../../../src/storage/types.js";
import { canonicalJson, compareUtf16 } from "../../../../src/transfer/format/canonical.js";
import { sha256Hex } from "../../../../src/transfer/format/digest.js";
import {
	KIND_FEATURE,
	requiredFeaturesFor,
	type SitePackageFeature,
} from "../../../../src/transfer/format/features.js";
import {
	RECORD_KINDS,
	type RecordKind,
	type SitePackageRecord,
} from "../../../../src/transfer/format/kinds.js";
import type {
	PackageFileEntry,
	SitePackageManifest,
} from "../../../../src/transfer/format/manifest.js";
import {
	MANIFEST_PATH,
	mediaBlobPath,
	recordChunkPath,
} from "../../../../src/transfer/format/paths.js";
import {
	SITE_PACKAGE_FORMAT,
	SITE_PACKAGE_FORMAT_VERSION,
	SITE_PACKAGE_PROFILE,
} from "../../../../src/transfer/format/version.js";
import { TransferOperationRepository } from "../../../../src/transfer/ops/operations.js";
import { TransferStagedFileRepository } from "../../../../src/transfer/ops/staged-files.js";
import { stagingPrefix } from "../../../../src/transfer/staging/keys.js";
import { StagedPackageWriter } from "../../../../src/transfer/staging/package.js";
import { TransferStage } from "../../../../src/transfer/staging/stage.js";
import {
	GOLDEN_IDS,
	GOLDEN_MEDIA_BYTES,
	goldenRecords,
	inStreamOrder,
} from "../../../utils/transfer/golden-package.js";

export const SENTINEL = "SENTINEL-7f3a9c-do-not-echo";

export type PackageRecords = Record<RecordKind, SitePackageRecord[]>;

export interface StagePackageOptions {
	/** Change the golden records before they are written (records are in stream order). */
	mutate?: (records: PackageRecords, blobs: Map<string, string>) => void;
	/** Replace the encoded lines of a kind (after `mutate`). */
	lines?: Partial<Record<RecordKind, (lines: string[]) => string[]>>;
	/** Media ids whose bytes are left out of the package. */
	omitBlobs?: readonly string[];
	/** Records per chunk (default 1000). */
	chunkRecords?: number;
	/** Change the manifest; written without validation. */
	manifest?: (manifest: SitePackageManifest) => SitePackageManifest;
	/** Index entries to add or change before the index is written. */
	index?: (entries: PackageFileEntry[]) => PackageFileEntry[];
	/** Staged-file rows: skip, or leave `declared`, these paths. */
	undeclared?: readonly string[];
	notUploaded?: readonly string[];
}

export interface StagedImport {
	operationId: string;
	stage: TransferStage;
	manifest: SitePackageManifest;
	records: PackageRecords;
	blobs: Map<string, string>;
}

function hasLocale(record: SitePackageRecord): string | undefined {
	return "locale" in record && typeof record.locale === "string" ? record.locale : undefined;
}

export async function goldenBlobs(): Promise<Map<string, string>> {
	const blobs = new Map<string, string>();
	for (const [mediaId, bytes] of Object.entries(GOLDEN_MEDIA_BYTES)) {
		blobs.set(mediaId, await sha256Hex(bytes));
	}
	return blobs;
}

export async function orderedGoldenRecords(): Promise<{
	records: PackageRecords;
	blobs: Map<string, string>;
}> {
	const blobs = await goldenBlobs();
	const grouped = goldenRecords(blobs);
	const records = {} as PackageRecords;
	for (const kind of RECORD_KINDS) {
		records[kind] = inStreamOrder(kind, grouped[kind]).map(({ record }) => record);
	}
	return { records, blobs };
}

export async function stagePackage(
	db: Kysely<Database>,
	storage: Storage,
	options: StagePackageOptions = {},
): Promise<StagedImport> {
	const repo = new TransferOperationRepository(db);
	const { operation } = await repo.create({ kind: "import", createdBy: "admin" });
	const stage = new TransferStage(
		storage,
		stagingPrefix("import", operation.id, operation.stagingSecret),
	);
	const writer = new StagedPackageWriter(stage);

	const { records, blobs } = await orderedGoldenRecords();
	options.mutate?.(records, blobs);

	const chunkRecords = options.chunkRecords ?? 1000;
	const files: PackageFileEntry[] = [];
	const summaries: SitePackageManifest["records"] = {};
	const locales = new Set<string>(["en"]);
	const features = new Set<SitePackageFeature>();
	let trash = false;
	for (const kind of RECORD_KINDS) {
		for (const record of records[kind]) {
			const locale = hasLocale(record);
			if (locale) locales.add(locale);
			if (record.kind === "entry" && record.deletedAt !== undefined) trash = true;
		}
		let lines = records[kind].map((record) => canonicalJson(record));
		const edit = options.lines?.[kind];
		if (edit) lines = edit(lines);
		if (lines.length === 0) continue;
		features.add(KIND_FEATURE[kind]);
		let chunks = 0;
		for (let start = 0; start < lines.length; start += chunkRecords) {
			const slice = lines.slice(start, start + chunkRecords);
			const entry = await writer.writeFile(
				recordChunkPath(kind, chunks),
				new TextEncoder().encode(`${slice.join("\n")}\n`),
			);
			files.push({ ...entry, records: slice.length });
			chunks++;
		}
		summaries[kind] = { count: lines.length, chunks };
	}

	const omitted = new Set(options.omitBlobs ?? []);
	const written = new Set<string>();
	let mediaBytes = 0;
	for (const [mediaId, bytes] of Object.entries(GOLDEN_MEDIA_BYTES)) {
		if (omitted.has(mediaId)) continue;
		const sha = blobs.get(mediaId)!;
		if (written.has(sha)) continue;
		written.add(sha);
		files.push(await writer.writeFile(mediaBlobPath(sha), bytes));
		mediaBytes += bytes.byteLength;
	}
	if (written.size > 0) features.add("media");
	if (locales.size > 1) features.add("i18n");
	if (trash) features.add("trash");

	let entries = files.toSorted((a, b) => compareUtf16(a.path, b.path));
	if (options.index) entries = options.index(entries);
	const indexRef = await writer.writeIndexChunk(0, entries);

	const featureList = [...features].toSorted(compareUtf16);
	let manifest: SitePackageManifest = {
		format: SITE_PACKAGE_FORMAT,
		formatVersion: SITE_PACKAGE_FORMAT_VERSION,
		packageId: GOLDEN_IDS.packageId,
		originSiteId: GOLDEN_IDS.originSiteId,
		createdAt: "2026-04-01T00:00:00.000Z",
		createdByEmDashVersion: "0.0.0-golden",
		profile: SITE_PACKAGE_PROFILE,
		features: featureList,
		requiredFeatures: requiredFeaturesFor(featureList),
		locales: { default: "en", used: [...locales].toSorted(compareUtf16) },
		records: summaries,
		media: { count: written.size, totalBytes: mediaBytes },
		files: {
			count: entries.length,
			totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
		},
		index: [indexRef],
		transformations: [],
		fence: { attempts: 1 },
	};
	if (options.manifest) manifest = options.manifest(manifest);
	const manifestBytes = new TextEncoder().encode(canonicalJson(manifest));
	await stage.putVerified(
		MANIFEST_PATH,
		manifestBytes,
		manifestBytes.byteLength,
		await sha256Hex(manifestBytes),
	);

	const undeclared = new Set(options.undeclared ?? []);
	const notUploaded = new Set(options.notUploaded ?? []);
	const stagedFiles = new TransferStagedFileRepository(db);
	const declared = entries.filter((entry) => !undeclared.has(entry.path));
	await stagedFiles.declareMany(
		operation.id,
		declared
			.filter((entry) => !notUploaded.has(entry.path))
			.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
		"verified",
	);
	await stagedFiles.declareMany(
		operation.id,
		declared
			.filter((entry) => notUploaded.has(entry.path))
			.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
		"declared",
	);

	return { operationId: operation.id, stage, manifest, records, blobs };
}
