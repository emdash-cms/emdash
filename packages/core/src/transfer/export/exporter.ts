/**
 * The export operation, advanced in bounded steps.
 *
 * Each `advanceExport` call claims the operation's lease, runs units of work
 * until the step budget is spent, persists the cursor after every unit, and
 * releases the lease. Stages, in order:
 *
 * - fence capture (on the first step), then `export_media`: hash every
 *    exported media object from its origin key and record the blob;
 * - `export_records`: every record kind in package order, one chunk per unit;
 * - `export_finalize`: re-check the fence (restart the export on a change,
 *    up to the attempt limit), declare dropped rows, write the index chunks
 *    and the manifest;
 * - `export_validate`: re-read every record chunk, check digests and scan
 *    for storage keys, then run the injected package validator.
 *
 * Media blobs are never copied: the index lists `media/<sha256>` and the
 * bytes are served from the origin object ({@link ExportPackageReader}).
 */

import type { Kysely } from "kysely";
import { ulid } from "ulidx";
import { z } from "zod";

import type { Database } from "../../database/types.js";
import { getI18nConfig } from "../../i18n/config.js";
import type { Storage } from "../../storage/types.js";
import { VERSION } from "../../version.js";
import { TransferError, isTransferError, type TransferErrorCode } from "../errors.js";
import { compareUtf16 } from "../format/canonical.js";
import { KIND_FEATURE, requiredFeaturesFor, type SitePackageFeature } from "../format/features.js";
import { RECORD_KINDS, type RecordKind, type SitePackageRecord } from "../format/kinds.js";
import { TRANSFER_LIMITS } from "../format/limits.js";
import {
	indexChunkRefSchema,
	type IndexChunkRef,
	type PackageFileEntry,
	type SitePackageManifest,
} from "../format/manifest.js";
import {
	rewriteMediaRefs,
	scanForKeys,
	scannableKeys,
	type MediaKeyIndex,
} from "../format/media-refs.js";
import { mediaBlobPath, parsePackagePath, recordChunkPath } from "../format/paths.js";
import type { PlanBlocker, PlanWarning } from "../format/plan.js";
import { encodeRecordLine } from "../format/records.js";
import {
	EXPORT_TRANSFORMATION_CODES,
	type ExportTransformation,
	type ExportTransformationCode,
} from "../format/transformations.js";
import {
	SITE_PACKAGE_FORMAT,
	SITE_PACKAGE_FORMAT_VERSION,
	SITE_PACKAGE_PROFILE,
} from "../format/version.js";
import { TransferStepBudget } from "../ops/budget.js";
import { TransferMediaBlobRepository } from "../ops/media-blobs.js";
import { TransferOperationRepository, type TransferOperation } from "../ops/operations.js";
import { TransferStagedFileRepository } from "../ops/staged-files.js";
import type { ExportCursor, ExportFence, TransferCursor, TransferProgress } from "../ops/states.js";
import { getOrCreateSiteId } from "../site-id.js";
import { stagingPrefix } from "../staging/keys.js";
import { StagedPackageReader, StagedPackageWriter } from "../staging/package.js";
import { TransferStage } from "../staging/stage.js";
import { captureFence, fencesEqual } from "./fence.js";
import {
	hashStoredObject,
	listMediaCandidates,
	loadMediaKeyIndex,
	unlinkMediaPlaceholders,
} from "./media.js";
import { createReader, type KindReader, type ReaderOptions } from "./readers.js";

type Db = Kysely<Database>;

const encoder = new TextEncoder();
const PAGE_ROWS = 250;
const MEDIA_CANDIDATES_PER_PAGE = 50;
/** Sorts after every `index/<seq>.ndjson` path and before `media/`. */
const INDEX_PATHS_END = "index/~";

// ── Options ─────────────────────────────────────────────────────

export const exportOptionsSchema = z.strictObject({
	comments: z.boolean().optional(),
});

export type ExportOptions = z.infer<typeof exportOptionsSchema>;

export interface CreateExportInput {
	db: Db;
	createdBy: string;
	options?: ExportOptions;
	idempotencyKey?: string;
}

function includesComments(options: unknown): boolean {
	return exportOptionsSchema.parse(options ?? {}).comments ?? true;
}

/**
 * Create a pending export operation, or return the existing one for the same
 * idempotency key. Reusing a key with different options fails with
 * `TRANSFER_IDEMPOTENCY_CONFLICT`.
 */
export async function createExport(
	input: CreateExportInput,
): Promise<{ operation: TransferOperation; created: boolean }> {
	const options = exportOptionsSchema.parse(input.options ?? {});
	const result = await new TransferOperationRepository(input.db).create({
		kind: "export",
		createdBy: input.createdBy,
		idempotencyKey: input.idempotencyKey,
		options,
	});
	if (!result.created && includesComments(result.operation.options) !== includesComments(options)) {
		throw new TransferError(
			"TRANSFER_IDEMPOTENCY_CONFLICT",
			"Idempotency key was already used for an export with different options",
		);
	}
	return result;
}

// ── Validator hook ──────────────────────────────────────────────

export interface ExportPackageValidatorInput {
	db: Db;
	/** The finished package; blobs stream from their origin objects. */
	reader: StagedPackageReader;
	operationId: string;
	/** Opaque JSON state returned by the previous call, or null on the first. */
	state: unknown;
	budget: TransferStepBudget;
}

export interface ExportPackageValidatorResult {
	done: boolean;
	state: unknown;
	blockers: PlanBlocker[];
	warnings: PlanWarning[];
}

/** Package validation run over the finished export before it completes. */
export type ExportPackageValidator = (
	input: ExportPackageValidatorInput,
) => Promise<ExportPackageValidatorResult>;

// ── Summary carried in the cursor ───────────────────────────────

const count = z.number().int().nonnegative();

const exportSummarySchema = z.strictObject({
	/** Records per chunk, by kind. */
	chunks: z.record(z.string(), z.array(count)),
	locales: z.array(z.string()),
	trash: z.boolean(),
	/** `code:kind` → count of declared export transformations. */
	adjustments: z.record(z.string(), count),
	fenceVerified: z.boolean(),
	index: z.array(indexChunkRefSchema),
	files: z.strictObject({ count, bytes: count }),
});

type ExportSummary = z.infer<typeof exportSummarySchema>;

function emptySummary(): ExportSummary {
	return {
		chunks: {},
		locales: [],
		trash: false,
		adjustments: {},
		fenceVerified: false,
		index: [],
		files: { count: 0, bytes: 0 },
	};
}

function readSummary(value: unknown): ExportSummary {
	return value === undefined ? emptySummary() : exportSummarySchema.parse(value);
}

function recordsWritten(summary: ExportSummary): number {
	let total = 0;
	for (const counts of Object.values(summary.chunks)) {
		for (const records of counts) total += records;
	}
	return total;
}

const validationSchema = z.strictObject({
	phase: z.literal("validator"),
	state: z.json().nullable(),
});

function addAdjustment(
	summary: ExportSummary,
	code: ExportTransformationCode,
	kind: RecordKind,
	amount: number,
): void {
	if (amount <= 0) return;
	const key = `${code}:${kind}`;
	summary.adjustments[key] = (summary.adjustments[key] ?? 0) + amount;
}

/** Rows a reader leaves out of each kind, and how the package declares them. */
const DROP_CODES: Partial<Record<RecordKind, ExportTransformationCode>> = {
	field: "orphan_dropped",
	relation: "orphan_dropped",
	term: "orphan_dropped",
	byline_field_value: "orphan_dropped",
	byline_field_group_value: "orphan_dropped",
	revision: "orphan_dropped",
	content_byline: "orphan_dropped",
	seo: "orphan_dropped",
	comment: "orphan_dropped",
	comment_reaction: "orphan_dropped",
	menu_item: "soft_orphan_dropped",
	content_term: "soft_orphan_dropped",
	content_reference: "soft_orphan_dropped",
	widget: "soft_orphan_dropped",
	redirect: "redirect_duplicate_dropped",
	media: "media_not_ready_dropped",
};

// ── Advancing ───────────────────────────────────────────────────

export interface AdvanceExportInput {
	db: Db;
	storage: Storage;
	operationId: string;
	/** A lease the caller already holds; otherwise the step claims one. */
	leaseToken?: string;
	budget?: TransferStepBudget;
	/** Defaults to the site's configured default locale. */
	defaultLocale?: string;
	emdashVersion?: string;
	validatePackage?: ExportPackageValidator;
}

export type AdvanceExportOutcome = "advanced" | "complete" | "failed" | "busy" | "finished";

export interface AdvanceExportResult {
	operation: TransferOperation;
	/**
	 * `advanced`: more steps needed; `complete`/`failed`: this step finished
	 * the export; `busy`: another caller holds the lease; `finished`: the
	 * export was already terminal.
	 */
	outcome: AdvanceExportOutcome;
}

/** Codes a later step may not hit again. */
const TRANSIENT_CODES: ReadonlySet<TransferErrorCode> = new Set([
	"TRANSFER_STORAGE_ERROR",
	"TRANSFER_LEASE_LOST",
]);

type UnitResult =
	| { type: "cursor"; cursor: ExportCursor; endStep?: boolean }
	| { type: "yield" }
	| { type: "complete" }
	| { type: "fail"; code: TransferErrorCode; detail?: Record<string, string | number | null> };

/**
 * Run one bounded step of an export. Transient failures (storage errors,
 * a lost lease, non-transfer errors) release the lease and rethrow so a
 * later call resumes from the last persisted cursor; any other transfer
 * error fails the operation.
 */
export async function advanceExport(input: AdvanceExportInput): Promise<AdvanceExportResult> {
	const operations = new TransferOperationRepository(input.db);
	let operation: TransferOperation;
	let leaseToken = input.leaseToken;
	if (leaseToken === undefined) {
		const claim = await operations.claim(input.operationId, ["pending", "running"]);
		if (claim.outcome === "lease_active") return { operation: claim.operation, outcome: "busy" };
		if (claim.outcome === "invalid_state") {
			return { operation: claim.operation, outcome: "finished" };
		}
		operation = claim.operation;
		leaseToken = claim.leaseToken;
	} else {
		operation = await operations.require(input.operationId);
		if (operation.kind !== "export" || operation.leaseToken !== leaseToken) {
			throw new TransferError("TRANSFER_LEASE_LOST", "Transfer operation lease was lost");
		}
	}
	if (operation.kind !== "export") {
		await operations.release(operation.id, leaseToken);
		throw new TransferError("TRANSFER_INVALID_STATE", "Operation is not an export");
	}

	const step = new ExportStep(input, operation, leaseToken);
	try {
		const result = await step.run();
		return result;
	} catch (error) {
		if (isTransferError(error) && !TRANSIENT_CODES.has(error.code)) {
			const failed = await operations.fail(operation.id, leaseToken, {
				code: error.code,
				detail: error.detail,
			});
			return { operation: failed, outcome: "failed" };
		}
		if (!(isTransferError(error) && error.code === "TRANSFER_LEASE_LOST")) {
			await operations.release(operation.id, leaseToken).catch(() => undefined);
		}
		throw error;
	}
}

class ExportStep {
	readonly #input: AdvanceExportInput;
	readonly #db: Db;
	readonly #operations: TransferOperationRepository;
	readonly #stagedFiles: TransferStagedFileRepository;
	readonly #blobs: TransferMediaBlobRepository;
	readonly #budget: TransferStepBudget;
	readonly #stage: TransferStage;
	readonly #writer: StagedPackageWriter;
	readonly #options: ExportOptions;
	readonly #leaseToken: string;
	#operation: TransferOperation;
	#keys: MediaKeyIndex | null = null;
	#scannable: Set<string> | null = null;
	#readers = new Map<RecordKind, KindReader<RecordKind>>();
	#packageReader: ExportPackageReader | null = null;
	readonly #mediaExported = new Map<string, boolean>();

	constructor(input: AdvanceExportInput, operation: TransferOperation, leaseToken: string) {
		this.#input = input;
		this.#db = input.db;
		this.#operation = operation;
		this.#leaseToken = leaseToken;
		this.#operations = new TransferOperationRepository(input.db);
		this.#stagedFiles = new TransferStagedFileRepository(input.db);
		this.#blobs = new TransferMediaBlobRepository(input.db, operation.id);
		this.#budget = input.budget ?? new TransferStepBudget();
		this.#stage = new TransferStage(
			input.storage,
			stagingPrefix("export", operation.id, operation.stagingSecret),
		);
		this.#writer = new StagedPackageWriter(this.#stage);
		this.#options = exportOptionsSchema.parse(operation.options ?? {});
	}

	get #comments(): boolean {
		return this.#options.comments ?? true;
	}

	async run(): Promise<AdvanceExportResult> {
		let cursor = this.currentCursor();
		if (cursor === null) {
			cursor = await this.start(1);
			await this.persist(cursor, "running");
		}
		for (;;) {
			const result = await this.unit(cursor);
			switch (result.type) {
				case "yield": {
					const released = await this.#operations.release(this.#operation.id, this.#leaseToken);
					return { operation: released, outcome: "advanced" };
				}
				case "complete": {
					const total = this.progressTotal();
					const last = this.#operation.progress;
					const completed = await this.#operations.complete(this.#operation.id, this.#leaseToken, {
						ttlSeconds: TRANSFER_LIMITS.exportTtlSeconds,
						progress: {
							...last,
							done: total,
							total,
							...(last?.bytesDone === undefined ? {} : { bytesTotal: last.bytesDone }),
						},
					});
					return { operation: completed, outcome: "complete" };
				}
				case "fail": {
					const failed = await this.#operations.fail(this.#operation.id, this.#leaseToken, {
						code: result.code,
						detail: result.detail,
					});
					return { operation: failed, outcome: "failed" };
				}
				case "cursor":
					cursor = result.cursor;
					if (result.endStep) {
						const released = await this.#operations.release(this.#operation.id, this.#leaseToken, {
							cursor,
							stage: cursor.stage,
							progress: this.progressFor(cursor),
						});
						return { operation: released, outcome: "advanced" };
					}
					await this.persist(cursor);
					break;
			}
		}
	}

	private currentCursor(): ExportCursor | null {
		const cursor: TransferCursor | null = this.#operation.cursor;
		if (cursor === null) return null;
		switch (cursor.stage) {
			case "export_records":
			case "export_media":
			case "export_finalize":
			case "export_validate":
				return cursor;
			default:
				throw new TransferError("TRANSFER_INVALID_STATE", "Export cursor is not an export stage");
		}
	}

	private async persist(cursor: ExportCursor, state?: "running"): Promise<void> {
		this.#operation = await this.#operations.advance(this.#operation.id, this.#leaseToken, {
			cursor,
			stage: cursor.stage,
			progress: this.progressFor(cursor),
			...(state ? { state } : {}),
		});
	}

	/** Media, each exported record kind, finalize, and validate. */
	private progressTotal(): number {
		return this.exportedKinds().length + 3;
	}

	private progressFor(cursor: ExportCursor): TransferProgress {
		const kinds = this.exportedKinds();
		const total = this.progressTotal();
		switch (cursor.stage) {
			case "export_media":
				return { done: 0, total, records: 0 };
			case "export_records":
				return {
					done: 1 + kinds.indexOf(cursor.kind),
					total,
					records: recordsWritten(readSummary(cursor.summary)),
				};
			case "export_finalize": {
				const summary = readSummary(cursor.summary);
				return {
					done: 1 + kinds.length,
					total,
					records: recordsWritten(summary),
					bytesDone: summary.files.bytes,
				};
			}
			case "export_validate":
				return { ...this.#operation.progress, done: 2 + kinds.length, total };
		}
	}

	/** Capture the fence and start an attempt at the media stage. */
	private async start(attempt: number): Promise<ExportCursor> {
		const fence: ExportFence = await captureFence(this.#db, this.#operation.writeEpoch);
		return {
			stage: "export_media",
			attempt,
			fence,
			afterMediaId: null,
			summary: emptySummary(),
		};
	}

	private async unit(cursor: ExportCursor): Promise<UnitResult> {
		switch (cursor.stage) {
			case "export_media":
				return this.restartOnChangedFile(cursor.attempt, () => this.mediaUnit(cursor));
			case "export_records":
				return this.restartOnChangedFile(cursor.attempt, () => this.recordsUnit(cursor));
			case "export_finalize":
				return this.finalizeUnit(cursor);
			case "export_validate":
				return this.validateUnit(cursor);
		}
	}

	/**
	 * A file this attempt already staged under the same path with other bytes
	 * means the site changed since it was written (the step that wrote it did
	 * not persist its cursor): start a new attempt.
	 */
	private async restartOnChangedFile(
		attempt: number,
		run: () => Promise<UnitResult>,
	): Promise<UnitResult> {
		try {
			return await run();
		} catch (error) {
			if (isTransferError(error) && error.code === "TRANSFER_FILE_DIGEST_MISMATCH") {
				return this.restart(attempt);
			}
			throw error;
		}
	}

	// ── Media ──

	private async mediaUnit(
		cursor: Extract<ExportCursor, { stage: "export_media" }>,
	): Promise<UnitResult> {
		if (!this.#budget.canStart()) return { type: "yield" };
		this.#budget.start();
		const candidates = await listMediaCandidates(
			this.#db,
			cursor.afterMediaId,
			MEDIA_CANDIDATES_PER_PAGE,
		);
		if (candidates.length === 0) {
			return {
				type: "cursor",
				cursor: {
					stage: "export_records",
					attempt: cursor.attempt,
					fence: cursor.fence,
					kind: RECORD_KINDS[0],
					after: null,
					nextSeq: 0,
					summary: cursor.summary,
				},
			};
		}
		let after = cursor.afterMediaId;
		for (const candidate of candidates) {
			// The first object of a step may be any size; later ones must fit what is left.
			const first = this.#budget.bytesUsed === 0;
			if (!first && !this.#budget.canStart({ queries: 5, bytes: 1 })) break;
			const hashed = await hashStoredObject(this.#input.storage, candidate.storageKey, {
				maxBytes: first ? undefined : this.#budget.remaining().bytes,
			});
			if (hashed === "too_large") break;
			this.#budget.start(hashed?.bytes ?? 0);
			if (hashed === null) {
				if (candidate.status === "ready") {
					throw new TransferError(
						"TRANSFER_MEDIA_BLOB_MISSING",
						"Media file is missing from storage",
						{ detail: { mediaId: candidate.id } },
					);
				}
			} else {
				await this.#blobs.putMany([
					{ mediaId: candidate.id, sha256: hashed.sha256, bytes: hashed.bytes },
				]);
				await this.#stagedFiles.declareMany(
					this.#operation.id,
					[{ path: mediaBlobPath(hashed.sha256), bytes: hashed.bytes, sha256: hashed.sha256 }],
					"verified",
				);
			}
			after = candidate.id;
		}
		if (after === cursor.afterMediaId) return { type: "yield" };
		return { type: "cursor", cursor: { ...cursor, afterMediaId: after } };
	}

	// ── Records ──

	private reader(kind: RecordKind): KindReader<RecordKind> {
		let reader = this.#readers.get(kind);
		if (!reader) {
			const options: ReaderOptions = {
				exportOperationId: this.#operation.id,
				comments: this.#comments,
				mediaBlobs: async (ids) => {
					const entries = await this.#blobs.getMany(ids);
					return new Map(Array.from(entries, ([id, entry]) => [id, entry.sha256]));
				},
			};
			reader = createReader(this.#db, kind, options);
			this.#readers.set(kind, reader);
		}
		return reader;
	}

	/** Media ids among `ids` that this export did not hash (not in the package). */
	private async unexportedMedia(ids: readonly string[]): Promise<Set<string>> {
		const unknown = ids.filter((id) => !this.#mediaExported.has(id));
		if (unknown.length > 0) {
			const exported = await this.#blobs.getMany(unknown);
			for (const id of unknown) this.#mediaExported.set(id, exported.has(id));
		}
		return new Set(ids.filter((id) => this.#mediaExported.get(id) === false));
	}

	private async keyIndex(): Promise<{ keys: MediaKeyIndex; scannable: Set<string> }> {
		if (!this.#keys || !this.#scannable) {
			this.#keys = await loadMediaKeyIndex(this.#db);
			this.#scannable = scannableKeys(this.#keys);
		}
		return { keys: this.#keys, scannable: this.#scannable };
	}

	private exportedKinds(): RecordKind[] {
		return RECORD_KINDS.filter(
			(kind) => this.#comments || (kind !== "comment" && kind !== "comment_reaction"),
		);
	}

	private nextKind(kind: RecordKind): RecordKind | null {
		const kinds = this.exportedKinds();
		return kinds[kinds.indexOf(kind) + 1] ?? null;
	}

	private async recordsUnit(
		cursor: Extract<ExportCursor, { stage: "export_records" }>,
	): Promise<UnitResult> {
		if (!this.#budget.canStart({ bytes: 1 })) return { type: "yield" };
		const summary = readSummary(cursor.summary);
		const { keys, scannable } = await this.keyIndex();
		const reader = this.reader(cursor.kind);

		const records: SitePackageRecord[] = [];
		const lines: string[] = [];
		const locales = new Set(summary.locales);
		let bytes = 0;
		let after = cursor.after;
		let kindDone = false;
		fill: while (records.length < TRANSFER_LIMITS.chunkRecords) {
			const page = await reader.page(
				after,
				Math.min(PAGE_ROWS, TRANSFER_LIMITS.chunkRecords - records.length),
			);
			for (const row of page.rows) {
				if (row.record === null) {
					after = row.key;
					continue;
				}
				const rewritten = rewriteMediaRefs(row.record, {
					mode: "export",
					keys,
					relativize: true,
				});
				const error = rewritten.errors[0];
				if (error) {
					throw new TransferError(
						"TRANSFER_MEDIA_REF_INVALID",
						"Record holds a media reference that cannot be exported",
						{
							detail: {
								kind: cursor.kind,
								id: row.record.id,
								reason: error.code,
								path: error.path,
							},
						},
					);
				}
				const unlinked = unlinkMediaPlaceholders(
					rewritten.value,
					await this.unexportedMedia(rewritten.mediaIds),
				);
				const record = unlinked.record;
				const line = encodeRecordLine(record);
				if (scanForKeys(line, scannable).length > 0) {
					throw new TransferError(
						"TRANSFER_MEDIA_REF_INVALID",
						"Record still holds an origin storage key",
						{ detail: { kind: cursor.kind, id: record.id } },
					);
				}
				const lineBytes = encoder.encode(line).byteLength + 1;
				if (records.length > 0 && bytes + lineBytes > TRANSFER_LIMITS.chunkBytes) break fill;
				records.push(record);
				lines.push(line);
				bytes += lineBytes;
				after = row.key;
				for (const adjustment of row.adjustments) {
					addAdjustment(summary, adjustment.code, cursor.kind, adjustment.count);
				}
				addAdjustment(summary, "media_url_relativized", cursor.kind, rewritten.relativized);
				addAdjustment(summary, "media_ref_unlinked", cursor.kind, unlinked.count);
				if (rewritten.warnings.some((warning) => warning.code === "unknown_storage_key")) {
					addAdjustment(summary, "unknown_storage_key", cursor.kind, 1);
				}
				if ("locale" in record && typeof record.locale === "string") locales.add(record.locale);
				if (record.kind === "entry" && record.deletedAt !== undefined) summary.trash = true;
			}
			if (page.done) {
				kindDone = true;
				break;
			}
		}
		if (records.length > 0) {
			const entry = await this.#writer.writeRecordChunk(cursor.kind, cursor.nextSeq, records);
			await this.#stagedFiles.declareMany(
				this.#operation.id,
				[{ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 }],
				"verified",
			);
			this.#budget.start(entry.bytes);
			summary.chunks[cursor.kind] = [...(summary.chunks[cursor.kind] ?? []), records.length];
		} else {
			this.#budget.start(0);
		}
		summary.locales = [...locales].toSorted(compareUtf16);

		const nextSeq = records.length > 0 ? cursor.nextSeq + 1 : cursor.nextSeq;
		if (!kindDone) {
			return { type: "cursor", cursor: { ...cursor, after, nextSeq, summary } };
		}
		const next = this.nextKind(cursor.kind);
		if (next === null) {
			return {
				type: "cursor",
				cursor: {
					stage: "export_finalize",
					attempt: cursor.attempt,
					fence: cursor.fence,
					nextIndexSeq: 0,
					afterPath: null,
					summary,
				},
			};
		}
		return {
			type: "cursor",
			cursor: { ...cursor, kind: next, after: null, nextSeq: 0, summary },
		};
	}

	// ── Finalize ──

	private async finalizeUnit(
		cursor: Extract<ExportCursor, { stage: "export_finalize" }>,
	): Promise<UnitResult> {
		if (!this.#budget.canStart()) return { type: "yield" };
		this.#budget.start();
		const summary = readSummary(cursor.summary);

		if (!summary.fenceVerified) {
			const current = await this.#operations.require(this.#operation.id);
			const fence = await captureFence(this.#db, current.writeEpoch);
			if (!fencesEqual(cursor.fence, fence)) return this.restart(cursor.attempt);
			await this.declareDrops(summary);
			summary.fenceVerified = true;
			return { type: "cursor", cursor: { ...cursor, summary } };
		}

		const files = await this.#stagedFiles.list(this.#operation.id, {
			state: "verified",
			after: cursor.afterPath ?? INDEX_PATHS_END,
			limit: TRANSFER_LIMITS.chunkRecords,
		});
		const entries: PackageFileEntry[] = [];
		let bytes = 0;
		for (const file of files) {
			const parsed = parsePackagePath(file.path);
			if (!parsed || (parsed.type !== "records" && parsed.type !== "media")) continue;
			const entry: PackageFileEntry = { path: file.path, bytes: file.bytes, sha256: file.sha256 };
			if (parsed.type === "records") {
				const records = summary.chunks[parsed.kind]?.[parsed.seq];
				if (records === undefined) {
					throw new TransferError(
						"TRANSFER_EXPORT_ERROR",
						"Staged chunk is not part of the export",
						{
							detail: { path: file.path },
						},
					);
				}
				entry.records = records;
			}
			const size = encoder.encode(JSON.stringify(entry)).byteLength + 1;
			if (entries.length > 0 && bytes + size > TRANSFER_LIMITS.chunkBytes) break;
			entries.push(entry);
			bytes += size;
		}

		const lastEntry = entries.at(-1);
		if (lastEntry) {
			const ref: IndexChunkRef = await this.#writer.writeIndexChunk(cursor.nextIndexSeq, entries);
			await this.#stagedFiles.declareMany(
				this.#operation.id,
				[{ path: ref.path, bytes: ref.bytes, sha256: ref.sha256 }],
				"verified",
			);
			summary.index = [...summary.index, ref];
			summary.files = {
				count: summary.files.count + entries.length,
				bytes: summary.files.bytes + entries.reduce((sum, entry) => sum + entry.bytes, 0),
			};
			return {
				type: "cursor",
				cursor: {
					...cursor,
					nextIndexSeq: cursor.nextIndexSeq + 1,
					afterPath: lastEntry.path,
					summary,
				},
			};
		}

		const manifest = await this.buildManifest(summary, cursor.attempt);
		const digest = await this.#writer.writeManifest(manifest);
		this.#operation = await this.#operations.advance(this.#operation.id, this.#leaseToken, {
			packageDigest: digest,
		});
		return { type: "cursor", cursor: { stage: "export_validate", position: null } };
	}

	private async declareDrops(summary: ExportSummary): Promise<void> {
		for (const kind of this.exportedKinds()) {
			const rows = await this.reader(kind).countRows();
			if (rows === null) continue;
			const exported = (summary.chunks[kind] ?? []).reduce((sum, n) => sum + n, 0);
			const dropped = rows - exported;
			if (dropped === 0) continue;
			const code = DROP_CODES[kind];
			if (!code || dropped < 0) {
				throw new TransferError("TRANSFER_EXPORT_ERROR", "Rows could not be exported", {
					detail: { kind, rows, exported },
				});
			}
			addAdjustment(summary, code, kind, dropped);
		}
	}

	private async restart(attempt: number): Promise<UnitResult> {
		if (attempt >= TRANSFER_LIMITS.exportFenceAttempts) {
			return {
				type: "fail",
				code: "TRANSFER_EXPORT_CONCURRENT_WRITES",
				detail: { attempts: attempt },
			};
		}
		let deleted: number;
		do {
			deleted = await this.#stagedFiles.deleteForOperation(this.#operation.id);
		} while (deleted > 0);
		await this.#db
			.deleteFrom("_emdash_transfer_media_blobs")
			.where("operation_id", "=", this.#operation.id)
			.execute();
		this.#operation = await this.#operations.require(this.#operation.id);
		return { type: "cursor", cursor: await this.start(attempt + 1) };
	}

	private async buildManifest(
		summary: ExportSummary,
		attempts: number,
	): Promise<SitePackageManifest> {
		const totals = await this.#blobs.totals();
		const features = new Set<SitePackageFeature>();
		const records: SitePackageManifest["records"] = {};
		for (const kind of RECORD_KINDS) {
			const chunks = summary.chunks[kind];
			if (!chunks || chunks.length === 0) continue;
			records[kind] = { count: chunks.reduce((sum, n) => sum + n, 0), chunks: chunks.length };
			features.add(KIND_FEATURE[kind]);
		}
		if (this.#comments) features.add("comments");
		if (totals.blobs > 0) features.add("media");
		const defaultLocale =
			this.#input.defaultLocale ?? getI18nConfig()?.defaultLocale ?? summary.locales[0] ?? "en";
		const locales = new Set([...summary.locales, defaultLocale]);
		if (locales.size > 1) features.add("i18n");
		if (summary.trash) features.add("trash");
		const featureList = [...features].toSorted(compareUtf16);

		const transformations: ExportTransformation[] = [];
		for (const [key, amount] of Object.entries(summary.adjustments)) {
			const [code, kind] = key.split(":");
			const known = EXPORT_TRANSFORMATION_CODES.find((candidate) => candidate === code);
			const recordKind = RECORD_KINDS.find((candidate) => candidate === kind);
			if (!known || !recordKind || amount === 0) continue;
			transformations.push({ code: known, kind: recordKind, count: amount });
		}
		transformations.sort((a, b) => compareUtf16(a.code, b.code) || compareUtf16(a.kind, b.kind));

		return {
			format: SITE_PACKAGE_FORMAT,
			formatVersion: SITE_PACKAGE_FORMAT_VERSION,
			packageId: ulid(),
			originSiteId: await getOrCreateSiteId(this.#db),
			createdAt: new Date().toISOString(),
			createdByEmDashVersion: this.#input.emdashVersion ?? VERSION,
			profile: SITE_PACKAGE_PROFILE,
			features: featureList,
			requiredFeatures: requiredFeaturesFor(featureList),
			locales: { default: defaultLocale, used: [...locales].toSorted(compareUtf16) },
			records,
			media: { count: totals.blobs, totalBytes: totals.blobBytes },
			files: { count: summary.files.count, totalBytes: summary.files.bytes },
			index: summary.index,
			transformations,
			fence: { attempts },
		};
	}

	// ── Validate ──

	private packageReader(): ExportPackageReader {
		this.#packageReader ??= new ExportPackageReader(
			this.#stage,
			this.#db,
			this.#input.storage,
			this.#operation.id,
		);
		return this.#packageReader;
	}

	private async validateUnit(
		cursor: Extract<ExportCursor, { stage: "export_validate" }>,
	): Promise<UnitResult> {
		const reader = this.packageReader();
		if (cursor.validation === undefined) {
			const manifest = await reader.manifest();
			const position = cursor.position ?? firstChunk(manifest);
			if (position === null) {
				return {
					type: "cursor",
					cursor: { ...cursor, position: null, validation: { phase: "validator", state: null } },
				};
			}
			const path = recordChunkPath(position.kind, position.seq);
			const staged = await this.#stagedFiles.get(this.#operation.id, path);
			if (!staged) {
				throw new TransferError("TRANSFER_FILE_MISSING", "Record chunk was not staged", {
					detail: { path },
				});
			}
			if (!this.#budget.canStart({ bytes: staged.bytes })) return { type: "yield" };
			this.#budget.start(staged.bytes);
			const { scannable } = await this.keyIndex();
			const chunk = await reader.readChunk(position.kind, position.seq, staged);
			for (const record of chunk) {
				if (scanForKeys(record.line, scannable).length > 0) {
					throw new TransferError(
						"TRANSFER_MEDIA_REF_INVALID",
						"Package holds an origin storage key",
						{ detail: { kind: position.kind, id: record.record.id } },
					);
				}
			}
			const next = nextChunk(manifest, position);
			return {
				type: "cursor",
				cursor:
					next === null
						? { ...cursor, position: null, validation: { phase: "validator", state: null } }
						: { ...cursor, position: next },
			};
		}

		const validation = validationSchema.parse(cursor.validation);
		const validate = this.#input.validatePackage;
		if (!validate) return { type: "complete" };
		// The validator gets a fresh step so its first unit can always start.
		if (this.#budget.units > 0 || !this.#budget.canStart()) return { type: "yield" };
		const result = await validate({
			db: this.#db,
			reader,
			operationId: this.#operation.id,
			state: validation.state,
			budget: this.#budget,
		});
		const blocker = result.blockers[0];
		if (blocker) {
			return {
				type: "fail",
				code: "TRANSFER_EXPORT_ERROR",
				detail: {
					reason: "package_invalid",
					blocker: blocker.code,
					kind: blocker.kind ?? null,
					id: blocker.id ?? null,
				},
			};
		}
		if (result.done) return { type: "complete" };
		return {
			type: "cursor",
			cursor: {
				...cursor,
				validation: { phase: "validator", state: z.json().parse(result.state ?? null) },
			},
			endStep: true,
		};
	}
}

function firstChunk(
	manifest: SitePackageManifest,
): { kind: RecordKind; seq: number; line: number } | null {
	for (const kind of RECORD_KINDS) {
		if ((manifest.records[kind]?.chunks ?? 0) > 0) return { kind, seq: 0, line: 0 };
	}
	return null;
}

function nextChunk(
	manifest: SitePackageManifest,
	position: { kind: RecordKind; seq: number },
): { kind: RecordKind; seq: number; line: number } | null {
	if (position.seq + 1 < (manifest.records[position.kind]?.chunks ?? 0)) {
		return { kind: position.kind, seq: position.seq + 1, line: 0 };
	}
	for (const kind of RECORD_KINDS.slice(RECORD_KINDS.indexOf(position.kind) + 1)) {
		if ((manifest.records[kind]?.chunks ?? 0) > 0) return { kind, seq: 0, line: 0 };
	}
	return null;
}

// ── Reading a finished export ───────────────────────────────────

/**
 * Reader over an export's staging area. Record and index chunks come from
 * staging; `media/<sha256>` streams from the origin object of a media row
 * hashed to that digest.
 */
export class ExportPackageReader extends StagedPackageReader {
	readonly #db: Db;
	readonly #storage: Storage;
	readonly #operationId: string;

	constructor(stage: TransferStage, db: Db, storage: Storage, operationId: string) {
		super(stage);
		this.#db = db;
		this.#storage = storage;
		this.#operationId = operationId;
	}

	override async blob(sha256: string): Promise<ReadableStream<Uint8Array>> {
		const row = await this.#db
			.selectFrom("_emdash_transfer_media_blobs")
			.innerJoin("media", "media.id", "_emdash_transfer_media_blobs.media_id")
			.select(["media.storage_key as storage_key"])
			.where("_emdash_transfer_media_blobs.operation_id", "=", this.#operationId)
			.where("_emdash_transfer_media_blobs.sha256", "=", sha256)
			.orderBy("_emdash_transfer_media_blobs.media_id")
			.executeTakeFirst();
		if (!row) {
			throw new TransferError("TRANSFER_FILE_MISSING", "Blob is not part of this export", {
				detail: { path: mediaBlobPath(sha256) },
			});
		}
		try {
			return (await this.#storage.download(row.storage_key)).body;
		} catch (error) {
			throw new TransferError("TRANSFER_MEDIA_BLOB_MISSING", "Media file is missing from storage", {
				detail: { path: mediaBlobPath(sha256) },
				cause: error,
			});
		}
	}
}

/** Open a completed (or finalized) export's package for reading. */
export function openExportPackage(input: {
	db: Db;
	storage: Storage;
	operation: Pick<TransferOperation, "id" | "stagingSecret">;
}): ExportPackageReader {
	const stage = new TransferStage(
		input.storage,
		stagingPrefix("export", input.operation.id, input.operation.stagingSecret),
	);
	return new ExportPackageReader(stage, input.db, input.storage, input.operation.id);
}
