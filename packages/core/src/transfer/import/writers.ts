/**
 * Per-kind writers for every record kind that maps to one row of a fixed
 * table (everything except collections, fields, and entries).
 *
 * A batch is inserted with `ON CONFLICT DO NOTHING` and read back; each
 * stored row must equal the row the importer meant to write, so replaying a
 * batch after an interruption is a no-op. When a row keyed by a portable id
 * already exists with different content, that id belongs to an unrelated
 * target row: the record is written under a deterministic rewritten id,
 * recorded in the identity map, and later `by: "id"` references follow it.
 * Any other conflict (another unique constraint, a row that differs after a
 * rewrite) fails the batch with `TRANSFER_IMPORT_ERROR`; where the database
 * has transactions, the failed batch leaves no rows behind.
 */

import { sql } from "kysely";
import { ulid } from "ulidx";

import { withTransaction } from "../../database/transaction.js";
import { fingerprintBlockFields } from "../../schema/block-type-contract.js";
import type { BlockFieldDefinition } from "../../schema/block-types.js";
import { TransferError } from "../errors.js";
import { getPortableTableSpecForKind } from "../format/columns.js";
import type { ColumnCodec } from "../format/columns.js";
import type { RecordKind, RecordOfKind, SitePackageRecord } from "../format/kinds.js";
import { rowsPerInsert } from "../format/limits.js";
import { DECIDED_SETTING_NAMES } from "../format/settings.js";
import { applyTransformations } from "../format/transformations.js";
import { applyRewrittenIds, type ImportContext } from "./context.js";
import { hmacHex, ulidFromHash } from "./ids.js";
import { encodeRecord, firstDifference, recordCodecs, type Row } from "./rows.js";
import { estimateStatements, insertRows, selectByKeys, type ConflictAction } from "./sql.js";

export type FlatKind = Exclude<RecordKind, "principal" | "collection" | "field" | "entry">;

interface FlatKindConfig {
	/** Columns identifying a row. Only `["id"]` kinds can have their id rewritten. */
	key: readonly string[];
	conflict?: ConflictAction;
	/** Columns the importer fills that records do not carry. */
	derived?: (context: ImportContext, record: SitePackageRecord) => Promise<Row> | Row;
}

const ID_KEY = ["id"] as const;

async function blockTypeVersionFingerprint(record: SitePackageRecord): Promise<Row> {
	if (record.kind !== "block_type_version") throw new Error("Expected a block type version");
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- analysis refuses fields that `validateBlockFields` rejects
	const fields = record.fields as unknown as BlockFieldDefinition[];
	return { fingerprint: await fingerprintBlockFields(fields) };
}

const FLAT_KINDS: Readonly<Record<FlatKind, FlatKindConfig>> = {
	block_type: { key: ID_KEY },
	block_type_version: {
		key: ID_KEY,
		derived: (_context, record) => blockTypeVersionFingerprint(record),
	},
	taxonomy_def: { key: ID_KEY },
	relation: { key: ID_KEY },
	byline_field: { key: ID_KEY },
	media_folder: { key: ID_KEY },
	media: { key: ID_KEY },
	term: { key: ID_KEY },
	byline: { key: ID_KEY },
	byline_field_value: { key: ["byline_id", "field_id"] },
	byline_field_group_value: { key: ["translation_group", "field_id"] },
	revision: { key: ID_KEY },
	content_term: { key: ["collection", "entry_id", "taxonomy_id"] },
	content_byline: { key: ID_KEY },
	content_reference: { key: ID_KEY },
	seo: { key: ["collection", "content_id"] },
	menu: { key: ID_KEY },
	menu_item: { key: ID_KEY },
	widget_area: { key: ID_KEY },
	widget: { key: ID_KEY },
	section: { key: ID_KEY },
	redirect: {
		key: ID_KEY,
		derived: () => ({ config_revision: ulid(), source_guard: 1, write_generation: 0 }),
	},
	comment: { key: ID_KEY },
	comment_reaction: {
		key: ID_KEY,
		derived: async (context, record) => ({
			voter_hash: await hmacHex(context.operation.stagingSecret, `comment_reaction:${record.id}`),
		}),
	},
	setting: {
		key: ["name"],
		conflict: { type: "update", target: ["name"], update: ["value", "revision"] },
		derived: () => ({ revision: ulid() }),
	},
};

const NO_FIELD_COLUMNS = new Map();

/**
 * Identity-map kind recording each redirect the importer wrote disabled
 * because it would close a loop with the redirects written before it.
 * Verification reads it to predict those redirects.
 */
export const REDIRECT_LOOP_ENTITY = "redirect_loop_disabled";

/** Redirects checked for loops per query: up to three bound parameters each. */
const REDIRECT_LOOP_BATCH = rowsPerInsert(3);

export function isFlatKind(kind: RecordKind): kind is FlatKind {
	return Object.hasOwn(FLAT_KINDS, kind);
}

function tableOf(kind: FlatKind) {
	const spec = getPortableTableSpecForKind(kind);
	if (!spec) throw new Error(`No table for kind ${kind}`);
	return spec;
}

/** Statements one `writeRecords` call for `count` records of `kind` needs. */
export function estimateWrite(kind: FlatKind, count: number): number {
	const spec = tableOf(kind);
	const statements = (rows: number) =>
		estimateStatements(rows, Object.keys(spec.columns).length, FLAT_KINDS[kind].key.length) + 3;
	if (kind !== "redirect") return statements(count);
	const batches = Math.ceil(count / REDIRECT_LOOP_BATCH);
	return batches * (3 + statements(REDIRECT_LOOP_BATCH));
}

export interface WriteInput<K extends RecordKind> {
	record: RecordOfKind<K>;
	/** The record's canonical line, scanned for media placeholders. */
	line: string;
}

export interface WriteOptions {
	/** Extra columns per portable id, compared like record columns. */
	extra?: (record: { id: string }) => { row: Row; codecs: Readonly<Record<string, ColumnCodec>> };
}

/** Records that were actually written (decided settings may be skipped). */
export async function writeRecords<K extends FlatKind>(
	context: ImportContext,
	kind: K,
	inputs: ReadonlyArray<WriteInput<K>>,
	options: WriteOptions = {},
): Promise<Array<RecordOfKind<K>>> {
	const skipped = skippedSettings(context);
	const selected = inputs.filter((input) => kind !== "setting" || !skipped.has(input.record.id));
	if (selected.length === 0) return [];
	const transformed = selected.map((input) =>
		applyTransformations(input.record, context.plan, { fieldColumnTypes: NO_FIELD_COLUMNS }),
	);
	const resolved = await context.resolveMediaRefs(
		transformed,
		selected.map((input) => input.line),
	);
	if (kind !== "redirect") {
		await writeResolved(context, kind, resolved, options, false);
		return resolved;
	}
	const written: Array<RecordOfKind<K>> = [];
	for (let start = 0; start < resolved.length; start += REDIRECT_LOOP_BATCH) {
		const batch = resolved.slice(start, start + REDIRECT_LOOP_BATCH);
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- kind is "redirect"
		const redirects = await disableLoopClosers(context, batch as Array<RecordOfKind<"redirect">>);
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the same redirect records
		const records = redirects as unknown as Array<RecordOfKind<K>>;
		await writeResolved(context, kind, records, options, false);
		written.push(...records);
	}
	return written;
}

/**
 * The database refuses an enabled redirect that closes a loop of enabled
 * redirects (by exact source and destination). An origin can still hold such
 * a loop, and analysis only finds loops in packages of up to
 * `MAX_LOOP_CHECKED_REDIRECTS` redirects, so each redirect that would close
 * one with the redirects written before it (target rows, then the enabled
 * earlier records of `records`) is written disabled and recorded under
 * {@link REDIRECT_LOOP_ENTITY}. Rows of `records` already in the table (from
 * an interrupted attempt) are ignored, so a replay decides the same way.
 */
async function disableLoopClosers(
	context: ImportContext,
	records: ReadonlyArray<RecordOfKind<"redirect">>,
): Promise<Array<RecordOfKind<"redirect">>> {
	const candidates = records.filter((record) => record.enabled && record.destination !== "");
	if (candidates.length === 0) return [...records];
	const reach = await reachableSources(context, candidates);

	const closers = new Set<string>();
	candidates.forEach((record, index) => {
		const earlier = candidates.slice(0, index).filter((other) => !closers.has(other.id));
		const queue = [{ node: record.destination, moved: false }];
		const taken = new Set<string>();
		while (queue.length > 0) {
			const { node, moved } = queue.shift()!;
			for (const source of reach.get(node) ?? []) {
				// Reaching the start node itself without following a redirect is not a loop.
				if (source === record.source && (moved || source !== node)) {
					closers.add(record.id);
					return;
				}
				for (const other of earlier) {
					if (other.source !== source || taken.has(other.id)) continue;
					taken.add(other.id);
					queue.push({ node: other.destination, moved: true });
				}
			}
		}
	});
	if (closers.size === 0) return [...records];
	await context.identity.putMany(
		REDIRECT_LOOP_ENTITY,
		Array.from(closers, (id) => ({ portableId: id, targetId: id })),
	);
	return records.map((record) => (closers.has(record.id) ? { ...record, enabled: false } : record));
}

/**
 * For each candidate's destination, the candidate sources reachable from it
 * through enabled target redirects (including the destination itself when it
 * is one). Follows `idx_redirects_source` from each destination only;
 * `enabled <> 0` rather than `enabled = 1` keeps SQLite from choosing
 * `idx_redirects_enabled` and scanning every enabled redirect per step.
 */
async function reachableSources(
	context: ImportContext,
	candidates: ReadonlyArray<RecordOfKind<"redirect">>,
): Promise<Map<string, Set<string>>> {
	const starts = [...new Set(candidates.map((record) => record.destination))];
	const sources = [...new Set(candidates.map((record) => record.source))];
	const result = await sql<{ start: string; node: string }>`
		WITH RECURSIVE starts(node) AS (VALUES ${sql.join(starts.map((node) => sql`(${node})`))}),
		reach(start, node) AS (
			SELECT node, node FROM starts
			UNION
			SELECT reach.start, redirect.destination
			FROM reach JOIN _emdash_redirects AS redirect ON redirect.source = reach.node
			WHERE redirect.enabled <> 0 AND redirect.destination <> ''
				AND redirect.id NOT IN (${sql.join(candidates.map((record) => record.id))})
		)
		SELECT start, node FROM reach WHERE node IN (${sql.join(sources)})
	`.execute(context.db);
	const reach = new Map<string, Set<string>>();
	for (const row of result.rows) {
		const reached = reach.get(row.start) ?? new Set<string>();
		reached.add(row.node);
		reach.set(row.start, reached);
	}
	return reach;
}

function skippedSettings(context: ImportContext): ReadonlySet<string> {
	const { decisions } = context.plan;
	return new Set<string>([
		...(decisions.siteTitle === "target" ? DECIDED_SETTING_NAMES.title : []),
		...(decisions.siteTagline === "target" ? DECIDED_SETTING_NAMES.tagline : []),
	]);
}

function keyString(key: readonly string[], row: Row): string {
	return key.map((column) => String(row[column])).join("\u0000");
}

export function uniqueConflict(kind: RecordKind, id: string): TransferError {
	return new TransferError(
		"TRANSFER_IMPORT_ERROR",
		"Record conflicts with another target row on a unique key",
		{ detail: { kind, id, reason: "unique_conflict" } },
	);
}

/**
 * Decide what a stored row that differs from its record means. The row can
 * be one this import wrote in an interrupted attempt of the same unit: then
 * the difference is an importer defect, never a collision, and the import
 * fails with `stored_row_mismatch`. Only on a unit's first attempt can the row
 * predate the import, and only a row keyed by the record's own id can then
 * move aside: the record is rewritten to a new id. Anything else is a
 * `collision` the import cannot resolve.
 */
export function assertRewritable(
	context: ImportContext,
	row: { kind: RecordKind; id: string; column: string; idKeyed: boolean; rewritten: boolean },
): void {
	const detail = { kind: row.kind, id: row.id, column: row.column };
	if (!context.firstAttempt) {
		throw new TransferError(
			"TRANSFER_IMPORT_ERROR",
			"A row this import wrote does not read back as its record",
			{ detail: { ...detail, reason: "stored_row_mismatch" } },
		);
	}
	if (!row.idKeyed || row.rewritten) {
		throw new TransferError(
			"TRANSFER_IMPORT_ERROR",
			"Record collides with an existing target row",
			{
				detail: { ...detail, reason: "collision" },
			},
		);
	}
}

async function writeResolved<K extends FlatKind>(
	context: ImportContext,
	kind: K,
	records: ReadonlyArray<RecordOfKind<K>>,
	options: WriteOptions,
	retry: boolean,
): Promise<void> {
	const spec = tableOf(kind);
	const config = FLAT_KINDS[kind];
	const rewritten = await context.rewrittenIds(kind, records);
	const codecs: Record<string, ColumnCodec> = { ...recordCodecs(spec.columns) };
	const rows: Row[] = [];
	for (const record of records) {
		const target = applyRewrittenIds(record, rewritten);
		const row = {
			...encodeRecord(context.db, spec.columns, target, { kind, id: record.id }),
			...(config.derived ? await config.derived(context, record) : {}),
		};
		const extra = options.extra?.(record);
		if (extra) {
			Object.assign(row, extra.row);
			Object.assign(codecs, extra.codecs);
		}
		rows.push(row);
	}
	const columns = Object.keys(rows[0] ?? {});
	const collisions = await withTransaction(context.db, async (trx) => {
		await insertRows(trx, spec.table, columns, rows, config.conflict);
		const stored = new Map(
			(await selectByKeys(trx, spec.table, config.key, rows)).map((row) => [
				keyString(config.key, row),
				row,
			]),
		);
		const found: Array<RecordOfKind<K>> = [];
		rows.forEach((row, index) => {
			const record = records[index];
			if (!record) return;
			const existing = stored.get(keyString(config.key, row));
			if (!existing) throw uniqueConflict(kind, record.id);
			const column = firstDifference(context.db, codecs, row, existing, { float4: context.float4 });
			if (column === null) return;
			assertRewritable(context, {
				kind,
				id: record.id,
				column,
				idKeyed: config.key === ID_KEY,
				rewritten: retry || rewritten.has(`${kind}\u0000${record.id}`),
			});
			found.push(record);
		});
		return found;
	});
	if (collisions.length === 0) return;

	const mappings = await Promise.all(
		collisions.map(async (record) => ({
			portableId: record.id,
			targetId: await ulidFromHash(context.operationId, kind, record.id),
		})),
	);
	await context.identity.putMany(kind, mappings);
	context.noteRewrite(kind);
	await writeResolved(context, kind, collisions, options, true);
}
