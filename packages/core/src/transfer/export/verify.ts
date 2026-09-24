/**
 * Import verification: re-read the target through the exporter's readers and
 * compare it to the package, in bounded steps.
 *
 * For every package record chunk (except principals, which are never
 * written), each record's predicted target form is
 * `applyTransformations(record, plan)`. The target row is read with the same
 * reader the exporter uses, rewritten ids are mapped back to portable ids
 * through the identity map, and target storage keys become placeholders
 * again (`rewriteMediaRefs` verify mode). A record verifies when both forms
 * have the same canonical JSON. Each chunk's logical hash is stored on its
 * staged file; the logical digest is computed from those at the end.
 *
 * Redirects the importer disabled because they would close a loop (listed
 * in the identity map) are predicted disabled.
 *
 * After the records, every inferred credit this import materialized (listed
 * in the identity map) must exist as recorded, the number of target rows per
 * kind must equal the package count (plus those credits for
 * `content_byline`), and every media object is downloaded again and must hash
 * to its blob.
 */

import type { Kysely } from "kysely";
import { z } from "zod";

import type { Database } from "../../database/types.js";
import type { Storage } from "../../storage/types.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { isTransferError, TransferError } from "../errors.js";
import { canonicalJson } from "../format/canonical.js";
import {
	chunkLogicalSha256,
	logicalDigest,
	recordSha256,
	type Sha256Digest,
} from "../format/digest.js";
import {
	KIND_REFERENCES,
	RECORD_KINDS,
	syntheticId,
	SYNTHETIC_ID_KINDS,
	type RecordKind,
	type SitePackageRecord,
} from "../format/kinds.js";
import { TRANSFER_LIMITS } from "../format/limits.js";
import {
	buildMediaKeyIndex,
	relativizePlaceholderUrls,
	rewriteMediaRefs,
	type MediaKeyIndex,
} from "../format/media-refs.js";
import { recordChunkPath } from "../format/paths.js";
import type { SiteImportPlan } from "../format/plan.js";
import { DECIDED_SETTING_NAMES } from "../format/settings.js";
import {
	applyTransformations,
	type FieldColumnType,
	type TransformationContext,
} from "../format/transformations.js";
import { INFERRED_CREDIT_ENTITY } from "../import/stages.js";
import { REDIRECT_LOOP_ENTITY } from "../import/writers.js";
import type { TransferStepBudget } from "../ops/budget.js";
import { TransferIdentityMapRepository } from "../ops/identity-map.js";
import { TransferStagedFileRepository } from "../ops/staged-files.js";
import { StagedPackageReader } from "../staging/package.js";
import { hashStoredObject, loadMediaKeyRows } from "./media.js";
import { createReader, type KindReader, type ReaderOptions } from "./readers.js";

type Db = Kysely<Database>;

export interface VerifyImportStepInput {
	db: Kysely<Database>;
	storage: Storage;
	operationId: string;
	/**
	 * The staged package being imported. Record chunks are read from its
	 * stage and checked against the digests they were verified with.
	 */
	reader: StagedPackageReader;
	plan: SiteImportPlan;
	/** The cursor returned by the previous step, or null on the first. */
	cursor: unknown;
	budget: TransferStepBudget;
}

export interface VerificationMismatch {
	kind: string;
	id: string;
	reason: string;
}

export type VerifyImportStepResult =
	| { done: false; cursor: unknown }
	| {
			done: true;
			logicalDigest: Sha256Digest;
			counts: Record<string, number>;
			mismatches: VerificationMismatch[];
	  };

const recordKindSchema = z.enum(RECORD_KINDS);
const nonNegative = z.number().int().nonnegative();

const verifyCursorSchema = z.strictObject({
	phase: z.enum(["records", "credits", "counts", "media", "digest"]),
	kind: recordKindSchema,
	seq: nonNegative,
	line: nonNegative,
	counts: z.record(z.string(), nonNegative),
	/** Inferred credits checked so far, and the last one checked. */
	credits: z.strictObject({ checked: nonNegative, after: z.string().nullable() }),
	mismatches: z
		.array(z.strictObject({ kind: z.string(), id: z.string(), reason: z.string() }))
		.max(TRANSFER_LIMITS.verificationMismatches),
});

type VerifyCursor = z.infer<typeof verifyCursorSchema>;

/** Kinds that are written to a target, in package order. */
const VERIFIED_KINDS: readonly RecordKind[] = RECORD_KINDS.filter((kind) => kind !== "principal");

/** Kinds whose target row count must equal the package count. */
const COUNTED_KINDS: readonly RecordKind[] = VERIFIED_KINDS.filter((kind) => kind !== "setting");

const CREDITS_PER_UNIT = 500;

/**
 * Run one bounded verification step. Returns `done: false` with a cursor to
 * pass to the next call, or the logical digest, verified counts per kind, and
 * at most `TRANSFER_LIMITS.verificationMismatches` mismatches.
 */
export async function verifyImportStep(
	input: VerifyImportStepInput,
): Promise<VerifyImportStepResult> {
	return new VerifyStep(input).run();
}

function initialCursor(): VerifyCursor {
	return {
		phase: "records",
		kind: VERIFIED_KINDS[0] ?? "collection",
		seq: 0,
		line: 0,
		counts: {},
		credits: { checked: 0, after: null },
		mismatches: [],
	};
}

class VerifyStep {
	readonly #input: VerifyImportStepInput;
	readonly #db: Db;
	readonly #identity: TransferIdentityMapRepository;
	readonly #reader: StagedPackageReader;
	readonly #readers = new Map<RecordKind, KindReader<RecordKind>>();
	#cursor: VerifyCursor;
	#rewrites: boolean | null = null;
	#keys: MediaKeyIndex | null = null;
	#context: TransformationContext | null = null;
	#packageBlobs = new Map<string, string>();

	constructor(input: VerifyImportStepInput) {
		this.#input = input;
		this.#db = input.db;
		this.#reader = new StagedPackageReader(
			input.reader.stage,
			new TransferStagedFileRepository(input.db).verifiedDigests(input.operationId),
		);
		this.#identity = new TransferIdentityMapRepository(
			input.db,
			input.plan.origin.siteId,
			input.operationId,
		);
		this.#cursor =
			input.cursor === null || input.cursor === undefined
				? initialCursor()
				: verifyCursorSchema.parse(input.cursor);
	}

	async run(): Promise<VerifyImportStepResult> {
		if ((await this.#reader.digest()) !== this.#input.plan.packageDigest) {
			throw new TransferError("TRANSFER_PACKAGE_DIGEST_MISMATCH", "Staged package does not match");
		}
		for (;;) {
			const progressed = await this.unit();
			if (progressed === "done") return this.finish();
			if (progressed === "yield") return { done: false, cursor: this.#cursor };
		}
	}

	private mismatch(kind: string, id: string, reason: string): void {
		if (this.#cursor.mismatches.length < TRANSFER_LIMITS.verificationMismatches) {
			this.#cursor.mismatches.push({ kind, id, reason });
		}
	}

	private async unit(): Promise<"continue" | "yield" | "done"> {
		const budget = this.#input.budget;
		if (!budget.canStart({ bytes: 1 })) return "yield";
		switch (this.#cursor.phase) {
			case "records":
				budget.start(1);
				await this.recordsUnit();
				return "continue";
			case "credits":
				budget.start(1);
				await this.creditsUnit();
				return "continue";
			case "counts":
				budget.start(1);
				await this.countsUnit();
				return "continue";
			case "media":
				return this.mediaUnit();
			case "digest":
				return "done";
		}
	}

	// ── Shared ──

	private reader(kind: RecordKind): KindReader<RecordKind> {
		let reader = this.#readers.get(kind);
		if (!reader) {
			const options: ReaderOptions = {
				mediaBlobs: async (ids) => {
					const portable = await this.portableIds("media", ids);
					const found = new Map<string, string>();
					for (const id of ids) {
						const blob = this.#packageBlobs.get(portable.get(id) ?? id);
						if (blob !== undefined) found.set(id, blob);
					}
					return found;
				},
			};
			reader = createReader(this.#db, kind, options);
			this.#readers.set(kind, reader);
		}
		return reader;
	}

	/** Whether any record id was rewritten on import. */
	private async hasRewrites(): Promise<boolean> {
		if (this.#rewrites === null) {
			const row = await this.#db
				.selectFrom("_emdash_transfer_identity_map")
				.select("portable_id")
				.where("operation_id", "=", this.#input.operationId)
				.where("entity_kind", "in", [...RECORD_KINDS])
				.limit(1)
				.executeTakeFirst();
			this.#rewrites = row !== undefined;
		}
		return this.#rewrites;
	}

	private async targetIds(kind: RecordKind, ids: readonly string[]): Promise<Map<string, string>> {
		if (!(await this.hasRewrites()) || ids.length === 0) return new Map();
		return this.#identity.getMany(kind, ids);
	}

	private async portableIds(
		kind: RecordKind,
		ids: readonly string[],
	): Promise<Map<string, string>> {
		if (!(await this.hasRewrites()) || ids.length === 0) return new Map();
		return this.#identity.getPortableIds(kind, ids);
	}

	/** Map a record's own id and its `by: "id"` references through `lookup`. */
	private async mapIds(
		records: SitePackageRecord[],
		lookup: (kind: RecordKind, ids: readonly string[]) => Promise<Map<string, string>>,
	): Promise<SitePackageRecord[]> {
		if (!(await this.hasRewrites()) || records.length === 0) return records;
		const kind = records[0]?.kind;
		if (!kind) return records;
		const properties: Array<{ property: string; target: RecordKind }> = [];
		if (!isSyntheticKind(kind) && kind !== "setting")
			properties.push({ property: "id", target: kind });
		for (const reference of KIND_REFERENCES[kind]) {
			const target = reference.targets[0];
			if (reference.by !== "id" || !target || target === "principal") continue;
			properties.push({ property: reference.property, target });
		}
		const maps = new Map<string, Map<string, string>>();
		for (const { property, target } of properties) {
			const values = records.flatMap((record) => {
				const value: unknown = Reflect.get(record, property);
				return typeof value === "string" ? [value] : [];
			});
			maps.set(property, await lookup(target, values));
		}
		return records.map((record) => {
			const next: Record<string, unknown> = { ...record };
			for (const { property } of properties) {
				const value = next[property];
				const mapped = typeof value === "string" ? maps.get(property)?.get(value) : undefined;
				if (mapped !== undefined) next[property] = mapped;
			}
			if (isSyntheticRecord(next)) next.id = syntheticId(next);
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- same record with id-valued properties replaced by other ids
			return next as SitePackageRecord;
		});
	}

	private async keyIndex(): Promise<MediaKeyIndex> {
		if (!this.#keys) {
			const rows = await loadMediaKeyRows(this.#db);
			const portable = await this.portableIds(
				"media",
				rows.map((row) => row.id),
			);
			this.#keys = buildMediaKeyIndex(
				rows.map((row) => ({ id: portable.get(row.id) ?? row.id, storageKey: row.storageKey })),
			);
		}
		return this.#keys;
	}

	private async transformationContext(): Promise<TransformationContext> {
		if (this.#context) return this.#context;
		const reader = this.#reader;
		const collections = new Map<string, string>();
		for await (const { record } of reader.records("collection")) {
			collections.set(record.id, record.slug);
		}
		const types = new Map<string, Map<string, FieldColumnType>>();
		for await (const { record } of reader.records("field")) {
			const slug = collections.get(record.collectionId);
			if (slug === undefined) continue;
			const fields = types.get(slug) ?? new Map<string, FieldColumnType>();
			fields.set(record.slug, record.columnType);
			types.set(slug, fields);
		}
		this.#context = { fieldColumnTypes: types };
		return this.#context;
	}

	private excludedSettings(): ReadonlySet<string> {
		const excluded = new Set<string>();
		const { decisions } = this.#input.plan;
		if (decisions.siteTitle === "target") {
			for (const name of DECIDED_SETTING_NAMES.title) excluded.add(name);
		}
		if (decisions.siteTagline === "target") {
			for (const name of DECIDED_SETTING_NAMES.tagline) excluded.add(name);
		}
		return excluded;
	}

	private chunkCount(
		kind: RecordKind,
		manifest: Awaited<ReturnType<StagedPackageReader["manifest"]>>,
	) {
		return manifest.records[kind]?.chunks ?? 0;
	}

	// ── Records ──

	private async recordsUnit(): Promise<void> {
		const manifest = await this.#reader.manifest();
		const { kind, seq } = this.#cursor;
		if (seq >= this.chunkCount(kind, manifest)) {
			this.advanceKind();
			return;
		}

		const chunk = await this.#reader.readChunk(kind, seq);
		const context = await this.transformationContext();
		const excluded = kind === "setting" ? this.excludedSettings() : new Set<string>();
		const packageRecords = chunk
			.map((staged) => staged.record)
			.filter((record) => !excluded.has(record.id));
		if (kind === "media") {
			for (const record of packageRecords) {
				if (record.kind === "media") this.#packageBlobs.set(record.id, record.blob);
			}
		}
		const predicted = await this.disabledLoopClosers(
			packageRecords.map((record) =>
				predictRelativeMediaUrls(applyTransformations(record, this.#input.plan, context)),
			),
		);

		const forward = await this.mapIds(predicted, (target, ids) => this.targetIds(target, ids));
		const lookup = forward.map((record) => record.id);
		const collections = new Map(
			forward.flatMap((record) =>
				record.kind === "entry" ? [[record.id, record.collection] as const] : [],
			),
		);
		const found = await this.readTargets(kind, lookup, collections);
		const targets = await this.mapIds(
			lookup.flatMap((id) => {
				const record = found.get(id);
				return record ? [record] : [];
			}),
			(target, ids) => this.portableIds(target, ids),
		);
		const byPortableId = new Map(targets.map((record) => [record.id, record]));
		const keys = await this.keyIndex();

		const hashes: Array<[string, string]> = [];
		let verified = 0;
		for (const expected of predicted) {
			const target = byPortableId.get(expected.id);
			if (!target) {
				this.mismatch(kind, expected.id, "missing");
				continue;
			}
			const rewritten = rewriteMediaRefs(target, { mode: "verify", keys, relativize: true });
			if (rewritten.errors.length > 0) {
				this.mismatch(kind, expected.id, `media_ref_${rewritten.errors[0]?.code ?? "invalid"}`);
			}
			const actual =
				rewritten.value.kind === "media" && expected.kind === "media"
					? { ...rewritten.value, blob: expected.blob }
					: rewritten.value;
			hashes.push([expected.id, await recordSha256(actual)]);
			if (canonicalJson(actual) === canonicalJson(expected)) verified++;
			else this.mismatch(kind, expected.id, "different");
		}

		await new TransferStagedFileRepository(this.#db).setLogicalSha256(
			this.#input.operationId,
			recordChunkPath(kind, seq),
			await chunkLogicalSha256(hashes),
		);
		this.#cursor.counts[kind] = (this.#cursor.counts[kind] ?? 0) + verified;
		this.#cursor.seq = seq + 1;
	}

	/** Redirects the importer wrote disabled because they would close a loop. */
	private async disabledLoopClosers(records: SitePackageRecord[]): Promise<SitePackageRecord[]> {
		const redirects = records.flatMap((record) => (record.kind === "redirect" ? [record.id] : []));
		if (redirects.length === 0) return records;
		const closers = await this.#identity.getMany(REDIRECT_LOOP_ENTITY, redirects);
		if (closers.size === 0) return records;
		return records.map((record) =>
			record.kind === "redirect" && closers.has(record.id) ? { ...record, enabled: false } : record,
		);
	}

	private async readTargets(
		kind: RecordKind,
		ids: readonly string[],
		collections: ReadonlyMap<string, string>,
	) {
		try {
			return await this.reader(kind).byIds(ids, collections);
		} catch (error) {
			if (isTransferError(error) && error.code === "TRANSFER_EXPORT_ERROR") {
				throw new TransferError(
					"TRANSFER_VERIFICATION_FAILED",
					"Target row is not a valid record",
					{
						detail: { ...error.detail, kind },
						cause: error,
					},
				);
			}
			throw error;
		}
	}

	private advanceKind(): void {
		const next = VERIFIED_KINDS[VERIFIED_KINDS.indexOf(this.#cursor.kind) + 1];
		if (next) {
			this.#cursor.kind = next;
			this.#cursor.seq = 0;
			return;
		}
		this.#cursor.phase = "credits";
		this.#cursor.seq = 0;
	}

	// ── Inferred credits ──

	private async creditsUnit(): Promise<void> {
		const mappings = await this.#identity.list(INFERRED_CREDIT_ENTITY, {
			after: this.#cursor.credits.after ?? undefined,
			limit: CREDITS_PER_UNIT,
		});
		const rows = new Map<
			string,
			{ byline_id: string; sort_order: unknown; role_label: string | null }
		>();
		for (const batch of chunks(
			mappings.map((mapping) => mapping.portableId),
			SQL_BATCH_SIZE,
		)) {
			const found = await this.#db
				.selectFrom("_emdash_content_bylines")
				.select(["id", "byline_id", "sort_order", "role_label"])
				.where("id", "in", batch)
				.execute();
			for (const row of found) rows.set(row.id, row);
		}
		for (const mapping of mappings) {
			const row = rows.get(mapping.portableId);
			if (!row) this.mismatch("content_byline", mapping.portableId, "inferred_credit_missing");
			else if (
				row.byline_id !== mapping.targetId ||
				Number(row.sort_order) !== 0 ||
				row.role_label !== null
			) {
				this.mismatch("content_byline", mapping.portableId, "inferred_credit_different");
			}
		}
		this.#cursor.credits.checked += mappings.length;
		const last = mappings.at(-1);
		if (last && mappings.length === CREDITS_PER_UNIT) {
			this.#cursor.credits.after = last.portableId;
			return;
		}
		this.#cursor.phase = "counts";
		this.#cursor.kind = COUNTED_KINDS[0] ?? "collection";
	}

	// ── Counts ──

	private async countsUnit(): Promise<void> {
		const manifest = await this.#reader.manifest();
		const kind = this.#cursor.kind;
		const rows = await this.reader(kind).countRows();
		let expected = manifest.records[kind]?.count ?? 0;
		if (kind === "content_byline") expected += this.#cursor.credits.checked;
		if (rows !== null && rows !== expected) {
			this.mismatch(kind, "*", `row_count expected=${expected} actual=${rows}`);
		}

		const next = COUNTED_KINDS[COUNTED_KINDS.indexOf(kind) + 1];
		if (next) {
			this.#cursor.kind = next;
			return;
		}
		this.#cursor.phase = "media";
		this.#cursor.kind = "media";
		this.#cursor.seq = 0;
		this.#cursor.line = 0;
	}

	// ── Media ──

	#mediaChunk: { seq: number; records: SitePackageRecord[]; keys: Map<string, string> } | null =
		null;

	private async mediaUnit(): Promise<"continue" | "yield" | "done"> {
		const manifest = await this.#reader.manifest();
		const { seq, line } = this.#cursor;
		if (seq >= this.chunkCount("media", manifest)) {
			this.#cursor.phase = "digest";
			return "continue";
		}
		if (this.#mediaChunk?.seq !== seq) {
			const records = (await this.#reader.readChunk("media", seq)).map((s) => s.record);
			const targetIds = await this.targetIds(
				"media",
				records.map((record) => record.id),
			);
			const ids = records.map((record) => targetIds.get(record.id) ?? record.id);
			const keys = new Map<string, string>();
			for (const row of await this.targetMediaKeys(ids)) keys.set(row.id, row.storageKey);
			const mapped = new Map<string, string>();
			records.forEach((record, index) => {
				const key = keys.get(ids[index] ?? record.id);
				if (key !== undefined) mapped.set(record.id, key);
			});
			this.#mediaChunk = { seq, records, keys: mapped };
		}

		const record = this.#mediaChunk.records[line];
		if (!record || record.kind !== "media") {
			this.#cursor.seq = seq + 1;
			this.#cursor.line = 0;
			return "continue";
		}
		const budget = this.#input.budget;
		// The first object of a step may be any size; later ones must fit what is left.
		const first = budget.bytesUsed === 0;
		if (!first && !budget.canStart({ bytes: 1 })) return "yield";

		const key = this.#mediaChunk.keys.get(record.id);
		if (key === undefined) {
			budget.start(1);
			this.mismatch("media", record.id, "missing");
		} else {
			const hashed = await hashStoredObject(this.#input.storage, key, {
				maxBytes: first ? undefined : budget.remaining().bytes,
			});
			if (hashed === "too_large") return "yield";
			budget.start(Math.max(hashed?.bytes ?? 0, 1));
			if (hashed === null) this.mismatch("media", record.id, "blob_missing");
			else if (hashed.sha256 !== record.blob) this.mismatch("media", record.id, "blob_mismatch");
		}
		this.#cursor.line = line + 1;
		return "continue";
	}

	private async targetMediaKeys(ids: readonly string[]) {
		const rows: Array<{ id: string; storageKey: string }> = [];
		for (const batch of chunks([...ids], SQL_BATCH_SIZE)) {
			const found = await this.#db
				.selectFrom("media")
				.select(["id", "storage_key"])
				.where("id", "in", batch)
				.execute();
			for (const row of found) rows.push({ id: row.id, storageKey: row.storage_key });
		}
		return rows;
	}

	// ── Digest ──

	private async finish(): Promise<VerifyImportStepResult> {
		const manifest = await this.#reader.manifest();
		const staged = new TransferStagedFileRepository(this.#db);
		const recordChunks: Array<[string, number]> = [];
		for (const kind of VERIFIED_KINDS) {
			for (let seq = 0; seq < this.chunkCount(kind, manifest); seq++) {
				recordChunks.push([kind, seq]);
			}
		}
		const files = await staged.getMany(
			this.#input.operationId,
			recordChunks.map(([kind, seq]) => recordChunkPath(kindOf(kind), seq)),
		);
		const tuples: Array<[string, number, string]> = [];
		for (const [kind, seq] of recordChunks) {
			const hash = files.get(recordChunkPath(kindOf(kind), seq))?.logicalSha256;
			if (!hash) {
				throw new TransferError("TRANSFER_IMPORT_ERROR", "Chunk was not verified", {
					detail: { kind, seq },
				});
			}
			tuples.push([kind, seq, hash]);
		}
		return {
			done: true,
			logicalDigest: await logicalDigest(tuples),
			counts: { ...this.#cursor.counts },
			mismatches: [...this.#cursor.mismatches],
		};
	}
}

/**
 * The importer writes a placeholder media URL relative to the target, so an
 * absolute one in a package record is predicted without its scheme and host.
 */
function predictRelativeMediaUrls(record: SitePackageRecord): SitePackageRecord {
	const text = canonicalJson(record);
	const relative = relativizePlaceholderUrls(text);
	if (relative === text) return record;
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the same record with some URL prefixes removed
	return JSON.parse(relative) as SitePackageRecord;
}

function kindOf(kind: string): RecordKind {
	const found = RECORD_KINDS.find((candidate) => candidate === kind);
	if (!found) throw new Error(`Unknown record kind ${kind}`);
	return found;
}

const SYNTHETIC: ReadonlySet<string> = new Set(SYNTHETIC_ID_KINDS);

function isSyntheticKind(kind: RecordKind): boolean {
	return SYNTHETIC.has(kind);
}

function isSyntheticRecord(
	record: Record<string, unknown>,
): record is Parameters<typeof syntheticId>[0] & Record<string, unknown> {
	return typeof record.kind === "string" && SYNTHETIC.has(record.kind);
}
