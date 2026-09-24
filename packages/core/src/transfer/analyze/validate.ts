/**
 * Staged package validation in bounded steps.
 *
 * Three passes, each resumable from a JSON-serializable state:
 * - `structure`: the manifest, every index chunk (verified against the digest
 *    the manifest pins), path grammar and ordering, per-kind chunk and record
 *    totals, and every indexed file staged, verified, and matching its index
 *    entry. Staged content files that the index does not list are rejected.
 * - `records`: every record chunk read and verified, every line strictly
 *    validated, per-kind counts, stream order (topological kinds: each parent
 *    earlier, depth = parent depth + 1), unique ids, and the package index
 *    (`_emdash_transfer_package_index`) filled for reference resolution.
 * - `references`: every `KIND_REFERENCES` entry, and the block type
 *    references held inside `blocks` fields and block types, resolved against
 *    the package index with bounded lookups, media placeholders resolved to `media`
 *    records, every media record's blob staged and verified, and — when a
 *    target is given — values checked against the target's column
 *    constraints.
 *
 * A step processes whole chunks and stops when the budget refuses the next
 * one. Nothing is held in memory between steps: all progress is in the
 * returned state and the package index.
 */

import type { Kysely } from "kysely";
import { z } from "zod";

import type { Database } from "../../database/types.js";
import { MAX_SELECT_OPTIONS } from "../../schema/byline-registry.js";
import {
	BYLINE_FIELD_TYPES,
	FIELD_TYPE_TO_COLUMN,
	FIELD_TYPES,
	type BylineFieldType,
} from "../../schema/types.js";
import { SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { isTransferError, TransferError } from "../errors.js";
import {
	blocksFieldTypeSlugs,
	blockTypeVersionKey,
	compareIds,
	compareStreamOrder,
	KIND_REFERENCES,
	RECORD_KINDS,
	streamOrderOf,
	TOPOLOGICAL_PARENT_PROPERTY,
	type RecordKind,
	type ReferenceKey,
	type SitePackageRecord,
	type StreamOrderKey,
	type TopologicalKind,
} from "../format/kinds.js";
import { rowsPerInsert, TRANSFER_LIMITS } from "../format/limits.js";
import type { PackageFileEntry, SitePackageManifest } from "../format/manifest.js";
import { mediaBlobPath, parsePackagePath, recordChunkPath } from "../format/paths.js";
import type { PlanBlocker, PlanWarning } from "../format/plan.js";
import { settingMediaIds } from "../format/settings.js";
import type { TransferStepBudget } from "../ops/budget.js";
import { TransferPackageIndexRepository, type PackageIndexEntry } from "../ops/package-index.js";
import { TransferStagedFileRepository } from "../ops/staged-files.js";
import type { StagedPackageReader } from "../staging/package.js";
import {
	addBlocker,
	addWarning,
	emptyIssues,
	finalWarnings,
	issueStateSchema,
	type IssueState,
} from "./issues.js";
import { blockerForError, decodeRecordLine, readVerifiedChunk } from "./read.js";
import { findUniqueCollisions, UNIQUE_CHECK_QUERIES, uniqueKeysOf } from "./unique-keys.js";
import {
	checkEntryFields,
	checkRecordNumbers,
	recordLocale,
	recordStringProperty,
	scanRecordValues,
	OTHER_PROVIDER,
	type FieldInfo,
	type TargetDialect,
	type ValueIssue,
} from "./values.js";
import { writeRuleIssues, type BylineFieldFacts } from "./write-rules.js";

const count = z.number().int().nonnegative();
const kindSchema = z.enum(RECORD_KINDS);
const kindCounts = z.array(z.tuple([kindSchema, count]));

export const VALIDATION_PHASES = ["structure", "records", "references", "done"] as const;
export type ValidationPhase = (typeof VALIDATION_PHASES)[number];

/**
 * Serialized validation progress. Maps are stored as entry lists: keys come
 * from the package and must never become object properties.
 */
export const validationStateSchema = z.strictObject({
	version: z.literal(1),
	phase: z.enum(VALIDATION_PHASES),
	nextIndexSeq: count,
	lastIndexPath: z.string().nullable(),
	indexedChunks: kindCounts,
	indexedRecords: kindCounts,
	indexedFiles: count,
	indexedBytes: count,
	indexedBlobs: count,
	indexedBlobBytes: count,
	recordBytes: count,
	kindIndex: count,
	seq: count,
	lastKey: z.strictObject({ id: z.string(), depth: count.optional() }).nullable(),
	seenRecords: kindCounts,
	unreadableKinds: z.array(kindSchema),
	collections: z.array(
		z.tuple([z.string(), z.strictObject({ id: z.string(), searchEnabled: z.boolean() })]),
	),
	fields: z.array(
		z.tuple([
			z.string(),
			z.array(
				z.tuple([
					z.string(),
					z.strictObject({
						columnType: z.enum(["TEXT", "REAL", "INTEGER", "JSON"]),
						required: z.boolean(),
					}),
				]),
			),
		]),
	),
	principals: z.array(
		z.strictObject({ id: z.string(), displayName: z.string(), email: z.string().optional() }),
	),
	principalReferences: z.array(z.tuple([z.string(), count])),
	principalBylineLocales: z.array(z.tuple([z.string(), z.array(z.string())])),
	principalsWithSharedLocaleBylines: z.array(z.string()),
	settings: z.strictObject({ title: z.string().optional(), tagline: z.string().optional() }),
	bylineFields: z.array(
		z.tuple([
			z.string(),
			z.strictObject({
				type: z.custom<BylineFieldType>(isBylineFieldType),
				options: z.array(z.string()).optional(),
			}),
		]),
	),
	float4Rounded: count,
	externalProviders: z.array(z.tuple([z.string(), count])),
	issues: issueStateSchema,
});

export type ValidationState = z.infer<typeof validationStateSchema>;

export interface ValidationTarget {
	dialect: TargetDialect;
	/** Largest media blob the target accepts, in bytes. */
	maxBlobBytes: number;
}

export interface ValidationOptions {
	/** Check values and blob sizes against a target site. */
	target?: ValidationTarget;
}

export interface ValidateStagedPackageInput {
	db: Kysely<Database>;
	reader: StagedPackageReader;
	/** Operation whose staged-file rows and package index this validation uses. */
	operationId: string;
	/** State returned by the previous step, or null to start. */
	state: unknown;
	budget: TransferStepBudget;
}

export interface ValidationStepResult {
	done: boolean;
	state: ValidationState;
	/** Every blocker found so far. */
	blockers: PlanBlocker[];
	/** Every warning found so far. */
	warnings: PlanWarning[];
}

export interface PrincipalSummary {
	id: string;
	displayName: string;
	email?: string;
}

interface WorkingState {
	phase: ValidationPhase;
	nextIndexSeq: number;
	lastIndexPath: string | null;
	indexedChunks: Map<RecordKind, number>;
	indexedRecords: Map<RecordKind, number>;
	indexedFiles: number;
	indexedBytes: number;
	indexedBlobs: number;
	indexedBlobBytes: number;
	recordBytes: number;
	kindIndex: number;
	seq: number;
	lastKey: StreamOrderKey | null;
	seenRecords: Map<RecordKind, number>;
	unreadableKinds: Set<RecordKind>;
	collections: Map<string, { id: string; searchEnabled: boolean }>;
	fields: Map<string, Map<string, FieldInfo>>;
	principals: PrincipalSummary[];
	principalReferences: Map<string, number>;
	principalBylineLocales: Map<string, Set<string>>;
	principalsWithSharedLocaleBylines: Set<string>;
	settings: { title?: string; tagline?: string };
	bylineFields: Map<string, BylineFieldFacts>;
	float4Rounded: number;
	externalProviders: Map<string, number>;
	issues: IssueState;
}

export function initialValidationState(): ValidationState {
	return serialize(initialWorkingState());
}

function initialWorkingState(): WorkingState {
	return {
		phase: "structure",
		nextIndexSeq: 0,
		lastIndexPath: null,
		indexedChunks: new Map(),
		indexedRecords: new Map(),
		indexedFiles: 0,
		indexedBytes: 0,
		indexedBlobs: 0,
		indexedBlobBytes: 0,
		recordBytes: 0,
		kindIndex: 0,
		seq: 0,
		lastKey: null,
		seenRecords: new Map(),
		unreadableKinds: new Set(),
		collections: new Map(),
		fields: new Map(),
		principals: [],
		principalReferences: new Map(),
		principalBylineLocales: new Map(),
		principalsWithSharedLocaleBylines: new Set(),
		settings: {},
		bylineFields: new Map(),
		float4Rounded: 0,
		externalProviders: new Map(),
		issues: emptyIssues(),
	};
}

function sortedEntries<V>(map: ReadonlyMap<string, V>): Array<[string, V]> {
	return [...map.entries()].toSorted(([a], [b]) => compareIds(a, b));
}

function serialize(state: WorkingState): ValidationState {
	return {
		version: 1,
		phase: state.phase,
		nextIndexSeq: state.nextIndexSeq,
		lastIndexPath: state.lastIndexPath,
		indexedChunks: [...state.indexedChunks.entries()],
		indexedRecords: [...state.indexedRecords.entries()],
		indexedFiles: state.indexedFiles,
		indexedBytes: state.indexedBytes,
		indexedBlobs: state.indexedBlobs,
		indexedBlobBytes: state.indexedBlobBytes,
		recordBytes: state.recordBytes,
		kindIndex: state.kindIndex,
		seq: state.seq,
		lastKey: state.lastKey
			? {
					id: state.lastKey.id,
					...(state.lastKey.depth === undefined ? {} : { depth: state.lastKey.depth }),
				}
			: null,
		seenRecords: [...state.seenRecords.entries()],
		unreadableKinds: [...state.unreadableKinds],
		collections: sortedEntries(state.collections),
		fields: sortedEntries(state.fields).map(([slug, fields]) => [slug, sortedEntries(fields)]),
		principals: state.principals,
		principalReferences: sortedEntries(state.principalReferences),
		principalBylineLocales: sortedEntries(state.principalBylineLocales).map(([id, locales]) => [
			id,
			[...locales].toSorted(compareIds),
		]),
		principalsWithSharedLocaleBylines: [...state.principalsWithSharedLocaleBylines].toSorted(
			compareIds,
		),
		settings: state.settings,
		bylineFields: sortedEntries(state.bylineFields),
		float4Rounded: state.float4Rounded,
		externalProviders: sortedEntries(state.externalProviders),
		issues: state.issues,
	};
}

function deserialize(state: ValidationState): WorkingState {
	return {
		phase: state.phase,
		nextIndexSeq: state.nextIndexSeq,
		lastIndexPath: state.lastIndexPath,
		indexedChunks: new Map(state.indexedChunks),
		indexedRecords: new Map(state.indexedRecords),
		indexedFiles: state.indexedFiles,
		indexedBytes: state.indexedBytes,
		indexedBlobs: state.indexedBlobs,
		indexedBlobBytes: state.indexedBlobBytes,
		recordBytes: state.recordBytes,
		kindIndex: state.kindIndex,
		seq: state.seq,
		lastKey: state.lastKey,
		seenRecords: new Map(state.seenRecords),
		unreadableKinds: new Set(state.unreadableKinds),
		collections: new Map(state.collections),
		fields: new Map(state.fields.map(([slug, fields]) => [slug, new Map(fields)])),
		principals: state.principals,
		principalReferences: new Map(state.principalReferences),
		principalBylineLocales: new Map(
			state.principalBylineLocales.map(([id, locales]) => [id, new Set(locales)]),
		),
		principalsWithSharedLocaleBylines: new Set(state.principalsWithSharedLocaleBylines),
		settings: state.settings,
		bylineFields: new Map(state.bylineFields),
		float4Rounded: state.float4Rounded,
		externalProviders: new Map(state.externalProviders),
		issues: state.issues,
	};
}

export function parseValidationState(value: unknown): ValidationState {
	const result = validationStateSchema.safeParse(value);
	if (!result.success) {
		throw new TransferError("TRANSFER_ANALYZE_ERROR", "Validation state is invalid");
	}
	return result.data;
}

interface Context {
	db: Kysely<Database>;
	reader: StagedPackageReader;
	operationId: string;
	manifest: SitePackageManifest;
	state: WorkingState;
	stagedFiles: TransferStagedFileRepository;
	index: TransferPackageIndexRepository;
	target: ValidationTarget | undefined;
}

/**
 * Run one bounded validation step. Blockers and warnings in the result are
 * cumulative; `done` is true once every pass has finished. Usable directly as
 * the exporter's self-validation hook.
 */
export async function validateStagedPackageStep(
	input: ValidateStagedPackageInput,
): Promise<ValidationStepResult> {
	return runValidationStep(input, {});
}

/** Validate a staged package to completion in one call (small packages, tests, tools). */
export async function validateStagedPackage(
	input: Omit<ValidateStagedPackageInput, "state" | "budget"> & {
		budget: () => TransferStepBudget;
		options?: ValidationOptions;
	},
): Promise<ValidationStepResult> {
	let state: unknown = null;
	for (;;) {
		const result = await runValidationStep(
			{ ...input, state, budget: input.budget() },
			input.options ?? {},
		);
		if (result.done) return result;
		state = result.state;
	}
}

export async function runValidationStep(
	input: ValidateStagedPackageInput,
	options: ValidationOptions,
): Promise<ValidationStepResult> {
	const state = deserialize(
		input.state === null || input.state === undefined
			? initialValidationState()
			: parseValidationState(input.state),
	);

	let manifest: SitePackageManifest | null = null;
	if (state.phase !== "done") {
		try {
			manifest = await input.reader.manifest();
		} catch (error) {
			if (!isTransferError(error)) throw error;
			addBlocker(state.issues, blockerForError(error, { path: "manifest.json" }));
			state.phase = "done";
		}
	}

	if (manifest && state.phase !== "done") {
		const context: Context = {
			db: input.db,
			reader: input.reader,
			operationId: input.operationId,
			manifest,
			state,
			stagedFiles: new TransferStagedFileRepository(input.db),
			index: new TransferPackageIndexRepository(input.db, input.operationId),
			target: options.target,
		};
		while (context.state.phase !== "done") {
			const bytes = await nextUnitBytes(context);
			if (!input.budget.canStart({ bytes, queries: unitQueries(context.state.phase) })) break;
			input.budget.start(bytes);
			await runUnit(context);
		}
	}

	const serialized = serialize(state);
	return {
		done: state.phase === "done",
		state: serialized,
		blockers: [...state.issues.blockers],
		warnings: finalWarnings(state.issues),
	};
}

// ── Scheduling ──────────────────────────────────────────────────

function kindAt(index: number): RecordKind | undefined {
	return RECORD_KINDS[index];
}

/** Index of the first kind at or after `from` that the manifest declares, or -1. */
function nextDeclaredKind(manifest: SitePackageManifest, from: number): number {
	for (let index = from; index < RECORD_KINDS.length; index++) {
		const kind = kindAt(index);
		if (kind && manifest.records[kind]) return index;
	}
	return -1;
}

/**
 * Upper bound on the queries one unit runs: a records chunk writes up to 1000
 * index rows and their unique keys; a references chunk looks up each
 * reference property of up to 1000 records.
 */
function unitQueries(phase: ValidationPhase): number {
	switch (phase) {
		case "records":
			return (
				Math.ceil(TRANSFER_LIMITS.chunkRecords / rowsPerInsert(7)) +
				2 * Math.ceil(TRANSFER_LIMITS.chunkRecords / SQL_BATCH_SIZE) +
				UNIQUE_CHECK_QUERIES +
				2
			);
		case "references":
			return 6 * Math.ceil(TRANSFER_LIMITS.chunkRecords / SQL_BATCH_SIZE) + 4;
		default:
			return 4;
	}
}

async function nextUnitBytes(context: Context): Promise<number> {
	const { state, manifest } = context;
	if (state.phase === "structure") {
		return manifest.index[state.nextIndexSeq]?.bytes ?? 0;
	}
	if (state.phase === "records" || state.phase === "references") {
		const kind = kindAt(state.kindIndex);
		if (!kind) return 0;
		const file = await context.stagedFiles.get(
			context.operationId,
			recordChunkPath(kind, state.seq),
		);
		return file?.bytes ?? 0;
	}
	return 0;
}

async function runUnit(context: Context): Promise<void> {
	const { state, manifest } = context;
	switch (state.phase) {
		case "structure":
			if (state.nextIndexSeq < manifest.index.length) await structureChunk(context);
			else {
				await finishStructure(context);
				startPass(context, "records");
			}
			return;
		case "records":
		case "references": {
			const kind = kindAt(state.kindIndex);
			if (!kind) {
				state.phase = state.phase === "records" ? "references" : "done";
				if (state.phase === "references") startPass(context, "references");
				return;
			}
			if (state.phase === "records") await recordsChunk(context, kind);
			else await referencesChunk(context, kind);
			advanceChunk(context, kind);
			return;
		}
		case "done":
			return;
	}
}

function startPass(context: Context, phase: "records" | "references"): void {
	const { state, manifest } = context;
	const first = nextDeclaredKind(manifest, 0);
	state.phase = first === -1 ? (phase === "records" ? "references" : "done") : phase;
	state.kindIndex = first === -1 ? RECORD_KINDS.length : first;
	state.seq = 0;
	state.lastKey = null;
	if (first === -1 && phase === "records") startPass(context, "references");
}

function advanceChunk(context: Context, kind: RecordKind): void {
	const { state, manifest } = context;
	state.seq++;
	if (state.seq < (manifest.records[kind]?.chunks ?? 0)) return;
	if (state.phase === "records") finishKindRecords(context, kind);
	const next = nextDeclaredKind(manifest, state.kindIndex + 1);
	state.kindIndex = next === -1 ? RECORD_KINDS.length : next;
	state.seq = 0;
	state.lastKey = null;
	if (next === -1) {
		if (state.phase === "records") startPass(context, "references");
		else state.phase = "done";
	}
}

// ── Structure ───────────────────────────────────────────────────

function bumpCount<K>(map: Map<K, number>, key: K, by = 1): void {
	map.set(key, (map.get(key) ?? 0) + by);
}

async function structureChunk(context: Context): Promise<void> {
	const { state, manifest } = context;
	const seq = state.nextIndexSeq;
	state.nextIndexSeq++;
	const indexPath = manifest.index[seq]?.path;

	let entries: PackageFileEntry[];
	try {
		entries = await context.reader.indexChunk(seq);
	} catch (error) {
		if (!isTransferError(error)) throw error;
		addBlocker(state.issues, blockerForError(error, { path: indexPath }));
		return;
	}

	for (const entry of entries) {
		if (state.lastIndexPath !== null && compareIds(state.lastIndexPath, entry.path) >= 0) {
			addBlocker(state.issues, {
				code: "package_invalid",
				message: "Index entries are not sorted by path or repeat a path",
				detail: { path: entry.path },
			});
		}
		state.lastIndexPath = entry.path;
		state.indexedFiles++;
		state.indexedBytes += entry.bytes;

		const parsed = parsePackagePath(entry.path);
		if (parsed?.type === "records") {
			const summary = manifest.records[parsed.kind];
			if (!summary || parsed.seq >= summary.chunks) {
				addBlocker(state.issues, {
					code: "package_invalid",
					message: "Record chunk is not declared by the manifest",
					kind: parsed.kind,
					detail: { path: entry.path },
				});
			}
			bumpCount(state.indexedChunks, parsed.kind);
			bumpCount(state.indexedRecords, parsed.kind, entry.records ?? 0);
			state.recordBytes += entry.bytes;
		} else if (parsed?.type === "media") {
			state.indexedBlobs++;
			state.indexedBlobBytes += entry.bytes;
			if (context.target && entry.bytes > context.target.maxBlobBytes) {
				addBlocker(state.issues, {
					code: "media_blob_too_large",
					message: "Media file is larger than this site accepts",
					detail: { path: entry.path, bytes: entry.bytes, limit: context.target.maxBlobBytes },
				});
			}
		}
	}

	const staged = await context.stagedFiles.getMany(
		context.operationId,
		entries.map((entry) => entry.path),
	);
	for (const entry of entries) {
		const file = staged.get(entry.path);
		if (!file) {
			addBlocker(state.issues, {
				code: "file_missing",
				message: "Package file has not been staged",
				detail: { path: entry.path },
			});
		} else if (file.bytes !== entry.bytes || file.sha256 !== entry.sha256) {
			addBlocker(state.issues, {
				code: "file_mismatch",
				message: "Staged file does not match its index entry",
				detail: { path: entry.path },
			});
		} else if (file.state !== "verified") {
			addBlocker(state.issues, {
				code: "file_missing",
				message: "Package file has not been uploaded",
				detail: { path: entry.path },
			});
		}
	}
}

async function countStagedContentFiles(context: Context): Promise<number> {
	const row = await context.db
		.selectFrom("_emdash_transfer_staged_files")
		.select((eb) => eb.fn.countAll<number | string>().as("count"))
		.where("operation_id", "=", context.operationId)
		.where((eb) => eb.or([eb("path", "like", "records/%"), eb("path", "like", "media/%")]))
		.executeTakeFirstOrThrow();
	return Number(row.count);
}

async function finishStructure(context: Context): Promise<void> {
	const { state, manifest } = context;
	for (const kind of RECORD_KINDS) {
		const summary = manifest.records[kind];
		const chunks = state.indexedChunks.get(kind) ?? 0;
		const records = state.indexedRecords.get(kind) ?? 0;
		if ((summary?.chunks ?? 0) !== chunks) {
			addBlocker(state.issues, {
				code: "package_invalid",
				message: "Index does not list every record chunk the manifest declares",
				kind,
				detail: { declared: summary?.chunks ?? 0, indexed: chunks },
			});
		} else if ((summary?.count ?? 0) !== records) {
			addBlocker(state.issues, {
				code: "record_count_mismatch",
				message: "Index record counts do not match the manifest",
				kind,
				detail: { declared: summary?.count ?? 0, indexed: records },
			});
		}
	}
	if (
		state.indexedBlobs !== manifest.media.count ||
		state.indexedBlobBytes !== manifest.media.totalBytes
	) {
		addBlocker(state.issues, {
			code: "package_invalid",
			message: "Indexed media does not match the manifest",
		});
	}
	if (
		state.indexedFiles !== manifest.files.count ||
		state.indexedBytes !== manifest.files.totalBytes
	) {
		addBlocker(state.issues, {
			code: "package_invalid",
			message: "Indexed files do not match the manifest",
		});
	}
	const staged = await countStagedContentFiles(context);
	if (staged > state.indexedFiles) {
		addBlocker(state.issues, {
			code: "package_invalid",
			message: "Staged files are not listed in the package index",
			count: staged - state.indexedFiles,
		});
	}
}

// ── Records ─────────────────────────────────────────────────────

interface ChunkRecord {
	record: SitePackageRecord;
	line: number;
}

/**
 * Decode one record chunk. With `report`, read and decode failures become
 * blockers; the references pass re-reads chunks the records pass already
 * reported and stays quiet.
 */
async function loadChunk(
	context: Context,
	kind: RecordKind,
	report: boolean,
): Promise<{ records: ChunkRecord[]; lines: number; path: string } | null> {
	const path = recordChunkPath(kind, context.state.seq);
	const file = await context.stagedFiles.get(context.operationId, path);
	if (!file || file.state !== "verified") return null;
	let lines: string[];
	try {
		lines = await readVerifiedChunk(context.reader.stage, path, file);
	} catch (error) {
		if (!isTransferError(error)) throw error;
		if (report) addBlocker(context.state.issues, blockerForError(error, { path }));
		return null;
	}
	const records: ChunkRecord[] = [];
	lines.forEach((line, index) => {
		const decoded = decodeRecordLine(kind, line, { path, line: index + 1 });
		if (decoded.ok) records.push({ record: decoded.record, line: index + 1 });
		else if (report) addBlocker(context.state.issues, decoded.blocker);
	});
	return { records, lines: lines.length, path };
}

function groupIdOf(record: SitePackageRecord): string {
	return recordStringProperty(record, "translationGroup") ?? record.id;
}

function nameKeyOf(record: SitePackageRecord): string | null {
	if (record.kind === "collection" || record.kind === "block_type") return record.slug;
	if (record.kind === "menu") return record.name;
	if (record.kind === "block_type_version") {
		return blockTypeVersionKey(record.blockTypeId, record.version);
	}
	return null;
}

function isTopologicalKind(kind: RecordKind): kind is TopologicalKind {
	return Object.hasOwn(TOPOLOGICAL_PARENT_PROPERTY, kind);
}

function parentOf(kind: RecordKind, record: SitePackageRecord): string | undefined {
	if (!isTopologicalKind(kind)) return undefined;
	return recordStringProperty(record, TOPOLOGICAL_PARENT_PROPERTY[kind]);
}

async function recordsChunk(context: Context, kind: RecordKind): Promise<void> {
	const { state, manifest } = context;
	const chunk = await loadChunk(context, kind, true);
	if (!chunk) {
		state.unreadableKinds.add(kind);
		return;
	}
	bumpCount(state.seenRecords, kind, chunk.lines);
	const topological = streamOrderOf(kind) === "topological";

	const chunkDepths = new Map<string, number>();
	let knownDepths = new Map<string, number>();
	if (topological) {
		const lookups = new Set<string>();
		for (const { record } of chunk.records) {
			lookups.add(record.id);
			const parent = parentOf(kind, record);
			if (parent !== undefined) lookups.add(parent);
		}
		knownDepths = await context.index.depths(kind, [...lookups]);
	}

	const usedLocales = new Set(manifest.locales.used);
	const entries: PackageIndexEntry[] = [];
	for (const { record, line } of chunk.records) {
		const location = { path: chunk.path, line };
		let depth: number | undefined;
		if (topological) {
			depth = 0;
			const parent = parentOf(kind, record);
			if (parent === record.id) {
				addBlocker(state.issues, {
					code: "reference_cycle",
					message: "Record is its own parent",
					kind,
					id: record.id,
					detail: location,
				});
			} else if (parent !== undefined) {
				const parentDepth = chunkDepths.get(parent) ?? knownDepths.get(parent);
				if (parentDepth === undefined) {
					addBlocker(state.issues, {
						code: "record_order_invalid",
						message: "Parent does not appear before its child",
						kind,
						id: record.id,
						detail: location,
					});
				} else depth = parentDepth + 1;
			}
			const stored = knownDepths.get(record.id);
			if (chunkDepths.has(record.id) || (stored !== undefined && stored !== depth)) {
				addBlocker(state.issues, {
					code: "duplicate_id",
					message: "Record id appears more than once",
					kind,
					id: record.id,
					detail: location,
				});
			}
			chunkDepths.set(record.id, depth);
		}

		const key: StreamOrderKey = depth === undefined ? { id: record.id } : { id: record.id, depth };
		if (state.lastKey && compareStreamOrder(kind, state.lastKey, key) >= 0) {
			const duplicate = state.lastKey.id === record.id;
			addBlocker(state.issues, {
				code: duplicate ? "duplicate_id" : "record_order_invalid",
				message: duplicate ? "Record id appears more than once" : "Records are out of stream order",
				kind,
				id: record.id,
				detail: location,
			});
		}
		state.lastKey = key;

		const locale = recordLocale(record);
		if (locale !== undefined && !usedLocales.has(locale)) {
			addBlocker(state.issues, {
				code: "package_invalid",
				message: "Record locale is not listed in the manifest",
				kind,
				id: record.id,
				detail: location,
			});
		}

		collectRecordFacts(context, record, location);

		const parent = parentOf(kind, record);
		entries.push({
			kind,
			id: record.id,
			groupId: groupIdOf(record),
			nameKey: nameKeyOf(record),
			parentId: parent ?? null,
			depth: depth ?? 0,
		});
	}
	await context.index.insertMany(entries);
	await checkUniqueKeys(context, kind, chunk.records, chunk.path);
}

async function checkUniqueKeys(
	context: Context,
	kind: RecordKind,
	records: readonly ChunkRecord[],
	path: string,
): Promise<void> {
	const keyed = records.map((item) => ({
		ownerId: item.record.id,
		keys: uniqueKeysOf(item.record),
		item,
	}));
	const collisions = await findUniqueCollisions(context.db, context.operationId, keyed);
	for (const { constraint, item, holderId } of collisions) {
		if (constraint === "byline_principal_locale") {
			const principal = recordStringProperty(item.record, "userPrincipal");
			if (principal !== undefined) context.state.principalsWithSharedLocaleBylines.add(principal);
			continue;
		}
		addBlocker(context.state.issues, {
			code: "unique_violation",
			message: "Record would duplicate another record's unique key on the target",
			kind,
			id: item.record.id,
			detail: { constraint, conflictsWith: holderId, path, line: item.line },
		});
	}
}

const FIELD_TYPE_SET: ReadonlySet<string> = new Set(FIELD_TYPES);
const BYLINE_FIELD_TYPE_SET: ReadonlySet<unknown> = new Set(BYLINE_FIELD_TYPES);

function isBylineFieldType(type: unknown): type is BylineFieldType {
	return BYLINE_FIELD_TYPE_SET.has(type);
}

/** The string choices in a select field's `validation.options`, as the write path reads them. */
function selectOptions(validation: unknown): string[] {
	if (typeof validation !== "object" || validation === null || Array.isArray(validation)) {
		return [];
	}
	const options: unknown = Reflect.get(validation, "options");
	return Array.isArray(options)
		? options.filter((option): option is string => typeof option === "string")
		: [];
}

function isKnownFieldType(type: string): type is keyof typeof FIELD_TYPE_TO_COLUMN {
	return FIELD_TYPE_SET.has(type);
}

/**
 * Records whose facts analysis keeps in its state. A package beyond these is
 * rejected rather than letting per-step state grow with the package.
 */
const MAX_TRACKED = {
	principals: 10_000,
	collections: 1_000,
	fields: 20_000,
	bylineFields: 1_000,
	providers: 100,
} as const;

function countFields(state: WorkingState): number {
	let total = 0;
	for (const fields of state.fields.values()) total += fields.size;
	return total;
}

function reportTrackingLimit(state: WorkingState, kind: RecordKind): void {
	const message = "Package has more records of this kind than a site supports";
	const reported = state.issues.blockers.some(
		(blocker) =>
			blocker.code === "limit_exceeded" && blocker.kind === kind && blocker.message === message,
	);
	if (!reported) addBlocker(state.issues, { code: "limit_exceeded", message, kind });
}

function collectRecordFacts(
	context: Context,
	record: SitePackageRecord,
	location: { path: string; line: number },
): void {
	const { state } = context;
	switch (record.kind) {
		case "principal":
			if (record.id === "__proto__") {
				addBlocker(state.issues, {
					code: "record_invalid",
					message: "Principal id is reserved",
					kind: "principal",
					detail: location,
				});
				return;
			}
			if (state.principals.length >= MAX_TRACKED.principals) {
				reportTrackingLimit(state, "principal");
				return;
			}
			state.principals.push({
				id: record.id,
				displayName: record.displayName,
				...(record.email === undefined ? {} : { email: record.email }),
			});
			return;
		case "collection": {
			const existing = state.collections.get(record.slug);
			if (existing && existing.id !== record.id) {
				addBlocker(state.issues, {
					code: "duplicate_id",
					message: "Collection slug appears more than once",
					kind: "collection",
					id: record.id,
					detail: location,
				});
				return;
			}
			const config = record.searchConfig;
			const searchEnabled =
				typeof config === "object" &&
				config !== null &&
				!Array.isArray(config) &&
				config.enabled === true;
			if (state.collections.size >= MAX_TRACKED.collections) {
				reportTrackingLimit(state, "collection");
				return;
			}
			state.collections.set(record.slug, { id: record.id, searchEnabled });
			return;
		}
		case "field": {
			if (!isKnownFieldType(record.type)) {
				addBlocker(state.issues, {
					code: "field_type_unknown",
					message: "Field type is not supported by this site",
					kind: "field",
					id: record.id,
					detail: location,
				});
				return;
			}
			if (FIELD_TYPE_TO_COLUMN[record.type] !== record.columnType) {
				addBlocker(state.issues, {
					code: "record_invalid",
					message: "Field column type does not match its field type",
					kind: "field",
					id: record.id,
					detail: location,
				});
				return;
			}
			let collectionSlug: string | undefined;
			for (const [slug, collection] of state.collections) {
				if (collection.id === record.collectionId) collectionSlug = slug;
			}
			if (collectionSlug === undefined) return;
			if (countFields(state) >= MAX_TRACKED.fields) {
				reportTrackingLimit(state, "field");
				return;
			}
			const fields = state.fields.get(collectionSlug) ?? new Map<string, FieldInfo>();
			if (fields.has(record.slug)) {
				addBlocker(state.issues, {
					code: "duplicate_id",
					message: "Field slug appears more than once in its collection",
					kind: "field",
					id: record.id,
					detail: location,
				});
				return;
			}
			fields.set(record.slug, {
				columnType: record.columnType,
				required: record.required === true,
			});
			state.fields.set(collectionSlug, fields);
			return;
		}
		case "byline_field": {
			if (!isBylineFieldType(record.type)) {
				addBlocker(state.issues, {
					code: "field_type_unknown",
					message: "Byline field type is not supported by this site",
					kind: "byline_field",
					id: record.id,
					detail: location,
				});
				return;
			}
			const options = record.type === "select" ? selectOptions(record.validation) : undefined;
			if (options !== undefined && options.length > MAX_SELECT_OPTIONS) {
				addBlocker(state.issues, {
					code: "value_constraint_violation",
					message: "Byline field has more choices than a site supports",
					kind: "byline_field",
					id: record.id,
					detail: { ...location, property: "validation" },
				});
				return;
			}
			if (state.bylineFields.size >= MAX_TRACKED.bylineFields) {
				reportTrackingLimit(state, "byline_field");
				return;
			}
			state.bylineFields.set(record.id, {
				type: record.type,
				...(options === undefined ? {} : { options }),
			});
			return;
		}
		case "setting":
			if (typeof record.value === "string") {
				if (
					record.id === "site:title" ||
					(record.id === "emdash:site_title" && !state.settings.title)
				) {
					state.settings.title = record.value.slice(0, 4096);
				}
				if (
					record.id === "site:tagline" ||
					(record.id === "emdash:site_tagline" && !state.settings.tagline)
				) {
					state.settings.tagline = record.value.slice(0, 4096);
				}
			}
			return;
		default:
			return;
	}
}

function finishKindRecords(context: Context, kind: RecordKind): void {
	const { state, manifest } = context;
	const declared = manifest.records[kind]?.count ?? 0;
	const seen = state.seenRecords.get(kind) ?? 0;
	if (declared !== seen && !state.unreadableKinds.has(kind)) {
		addBlocker(state.issues, {
			code: "record_count_mismatch",
			message: "Record count does not match the manifest",
			kind,
			detail: { declared, found: seen },
		});
	}
}

// ── References ──────────────────────────────────────────────────

function referenceValues(record: SitePackageRecord, property: string, many: boolean): string[] {
	if (!Object.hasOwn(record, property)) return [];
	const raw: unknown = Reflect.get(record, property);
	if (many) {
		return Array.isArray(raw)
			? raw.filter((value): value is string => typeof value === "string")
			: [];
	}
	return typeof raw === "string" ? [raw] : [];
}

async function referencesChunk(context: Context, kind: RecordKind): Promise<void> {
	const { state } = context;
	const chunk = await loadChunk(context, kind, false);
	if (!chunk) return;

	const principalIds = new Set(state.principals.map((principal) => principal.id));
	for (const reference of KIND_REFERENCES[kind]) {
		const owners = new Map<string, ChunkRecord[]>();
		for (const item of chunk.records) {
			for (const value of referenceValues(
				item.record,
				reference.property,
				reference.many === true,
			)) {
				const list = owners.get(value) ?? [];
				list.push(item);
				owners.set(value, list);
				if (reference.targets.includes("principal") && principalIds.has(value)) {
					bumpCount(state.principalReferences, value);
				}
			}
		}
		if (owners.size === 0) continue;
		const missing = await context.index.findMissing(reference.targets, reference.by, [
			...owners.keys(),
		]);
		for (const value of missing) {
			for (const item of owners.get(value) ?? []) {
				const detail = { property: reference.property, path: chunk.path, line: item.line };
				if (reference.soft) {
					addWarning(state.issues, {
						code: "soft_reference_dangling",
						message: "Reference does not resolve to a record in the package",
						kind,
						id: item.record.id,
						detail,
					});
				} else {
					addBlocker(state.issues, {
						code: "dangling_reference",
						message: "Reference does not resolve to a record in the package",
						kind,
						id: item.record.id,
						detail,
					});
				}
			}
		}
	}

	await checkNestedReferences(context, kind, chunk.records, chunk.path);
	await checkMediaReferences(context, kind, chunk.records, chunk.path);
	if (kind === "media") await checkMediaBlobs(context, chunk.records, chunk.path);

	for (const { record, line } of chunk.records) {
		if (
			record.kind === "byline" &&
			record.userPrincipal !== undefined &&
			principalIds.has(record.userPrincipal)
		) {
			const locales = state.principalBylineLocales.get(record.userPrincipal) ?? new Set<string>();
			locales.add(record.locale);
			state.principalBylineLocales.set(record.userPrincipal, locales);
		}
		if (context.target) checkTargetValues(context, record, { path: chunk.path, line });
	}
}

interface NestedReference {
	property: string;
	targets: readonly RecordKind[];
	by: ReferenceKey;
	values: (record: SitePackageRecord) => string[];
}

/**
 * References that live inside a property rather than being one: the block
 * types a `blocks` field names in `validation`, and the version a block type
 * names as current.
 */
const NESTED_REFERENCES: Partial<Record<RecordKind, NestedReference>> = {
	field: {
		property: "validation",
		targets: ["block_type"],
		by: "slug",
		values: (record) => (record.kind === "field" ? blocksFieldTypeSlugs(record) : []),
	},
	block_type: {
		property: "currentVersion",
		targets: ["block_type_version"],
		by: "name",
		values: (record) =>
			record.kind === "block_type" ? [blockTypeVersionKey(record.id, record.currentVersion)] : [],
	},
};

async function checkNestedReferences(
	context: Context,
	kind: RecordKind,
	records: readonly ChunkRecord[],
	path: string,
): Promise<void> {
	const reference = NESTED_REFERENCES[kind];
	if (!reference) return;
	const owners = new Map<string, ChunkRecord[]>();
	for (const item of records) {
		for (const value of reference.values(item.record)) {
			const list = owners.get(value) ?? [];
			list.push(item);
			owners.set(value, list);
		}
	}
	if (owners.size === 0) return;
	const missing = await context.index.findMissing(reference.targets, reference.by, [
		...owners.keys(),
	]);
	for (const value of missing) {
		for (const item of owners.get(value) ?? []) {
			addBlocker(context.state.issues, {
				code: "dangling_reference",
				message: "Reference does not resolve to a record in the package",
				kind,
				id: item.record.id,
				detail: { property: reference.property, path, line: item.line },
			});
		}
	}
}

async function checkMediaReferences(
	context: Context,
	kind: RecordKind,
	records: readonly ChunkRecord[],
	path: string,
): Promise<void> {
	const { state } = context;
	const placeholderOwners = new Map<string, ChunkRecord[]>();
	const settingOwners = new Map<string, ChunkRecord[]>();
	for (const item of records) {
		const scan = scanRecordValues(item.record);
		if (scan.malformed > 0) {
			addBlocker(state.issues, {
				code: "media_ref_invalid",
				message: "Record holds media placeholder text that is not a placeholder or an escape",
				kind,
				id: item.record.id,
				detail: { path, line: item.line },
			});
		}
		for (const mediaId of scan.placeholders) {
			const list = placeholderOwners.get(mediaId) ?? [];
			list.push(item);
			placeholderOwners.set(mediaId, list);
		}
		for (const [provider, uses] of scan.providers) {
			const key =
				state.externalProviders.has(provider) ||
				state.externalProviders.size < MAX_TRACKED.providers
					? provider
					: OTHER_PROVIDER;
			bumpCount(state.externalProviders, key, uses);
		}
		if (item.record.kind === "setting") {
			for (const mediaId of settingMediaIds(item.record.id, item.record.value)) {
				const list = settingOwners.get(mediaId) ?? [];
				list.push(item);
				settingOwners.set(mediaId, list);
			}
		}
	}
	if (placeholderOwners.size > 0) {
		const missing = await context.index.findMissing(["media"], "id", [...placeholderOwners.keys()]);
		for (const mediaId of missing) {
			for (const item of placeholderOwners.get(mediaId) ?? []) {
				addBlocker(state.issues, {
					code: "media_ref_invalid",
					message: "Media placeholder does not name a media record in the package",
					kind,
					id: item.record.id,
					detail: { path, line: item.line },
				});
			}
		}
	}
	if (settingOwners.size > 0) {
		const missing = await context.index.findMissing(["media"], "id", [...settingOwners.keys()]);
		for (const mediaId of missing) {
			for (const item of settingOwners.get(mediaId) ?? []) {
				addWarning(state.issues, {
					code: "media_row_missing",
					message: "Setting refers to media that is not in the package",
					kind,
					id: item.record.id,
				});
			}
		}
	}
}

async function checkMediaBlobs(
	context: Context,
	records: readonly ChunkRecord[],
	path: string,
): Promise<void> {
	const blobPaths = new Map<string, ChunkRecord[]>();
	for (const item of records) {
		if (item.record.kind !== "media") continue;
		const blobPath = mediaBlobPath(item.record.blob);
		const list = blobPaths.get(blobPath) ?? [];
		list.push(item);
		blobPaths.set(blobPath, list);
	}
	if (blobPaths.size === 0) return;
	const staged = await context.stagedFiles.getMany(context.operationId, [...blobPaths.keys()]);
	for (const [blobPath, items] of blobPaths) {
		const file = staged.get(blobPath);
		if (file && file.state === "verified") continue;
		for (const item of items) {
			addBlocker(context.state.issues, {
				code: "media_blob_missing",
				message: "Media record's file is not in the package",
				kind: "media",
				id: item.record.id,
				detail: { path, line: item.line },
			});
		}
	}
}

function reportValueIssues(
	context: Context,
	record: SitePackageRecord,
	issues: readonly ValueIssue[],
	location: { path: string; line: number },
): void {
	for (const issue of issues) {
		addBlocker(context.state.issues, {
			code: issue.code,
			message: issue.message,
			kind: record.kind,
			id: record.id,
			detail: {
				...location,
				property: issue.property,
				...(issue.field === undefined ? {} : { field: issue.field }),
			},
		});
	}
}

function checkTargetValues(
	context: Context,
	record: SitePackageRecord,
	location: { path: string; line: number },
): void {
	const target = context.target;
	if (!target) return;
	const numbers = checkRecordNumbers(record, target.dialect);
	context.state.float4Rounded += numbers.float4Rounded;
	reportValueIssues(context, record, numbers.issues, location);
	reportValueIssues(
		context,
		record,
		writeRuleIssues(record, { bylineFields: context.state.bylineFields }),
		location,
	);
	if (record.kind === "entry") {
		const fields = context.state.fields.get(record.collection);
		if (!fields) return;
		const values = checkEntryFields(record, fields, target.dialect);
		context.state.float4Rounded += values.float4Rounded;
		reportValueIssues(context, record, values.issues, location);
	}
}

// ── Summary for analysis ────────────────────────────────────────

export interface ValidationSummary {
	recordBytes: number;
	principals: PrincipalSummary[];
	principalReferences: ReadonlyMap<string, number>;
	principalBylineLocales: ReadonlyMap<string, ReadonlySet<string>>;
	/** Principals linked to more than one byline in some locale. */
	principalsWithSharedLocaleBylines: ReadonlySet<string>;
	settings: { title?: string; tagline?: string };
	/** Slugs of the package's collections. */
	collectionSlugs: string[];
	/** Collections whose search config enables full-text search. */
	searchEnabledCollections: string[];
	float4Rounded: number;
	externalProviders: ReadonlyMap<string, number>;
}

export function summarizeValidation(state: ValidationState): ValidationSummary {
	const working = deserialize(state);
	return {
		recordBytes: working.recordBytes,
		principals: working.principals,
		principalReferences: working.principalReferences,
		principalBylineLocales: working.principalBylineLocales,
		principalsWithSharedLocaleBylines: working.principalsWithSharedLocaleBylines,
		settings: working.settings,
		collectionSlugs: [...working.collections.keys()].toSorted(compareIds),
		searchEnabledCollections: [...working.collections.values()]
			.filter((collection) => collection.searchEnabled)
			.map((collection) => collection.id)
			.toSorted(compareIds),
		float4Rounded: working.float4Rounded,
		externalProviders: working.externalProviders,
	};
}
