/**
 * Per-kind readers: turn portable rows into strict package records.
 *
 * A reader pages through its kind in package stream order (`id` order, or
 * `(depth, id)` for the tree kinds) and can also fetch rows by id. The
 * exporter uses the paging side against the origin; import verification
 * uses the same readers against the target, so any database works.
 *
 * When paging, rows a package must not contain are left out: rows whose
 * reference (hard or soft) names a row that does not exist, tree rows below
 * such a row, and (for an export) media rows that were not hashed. Optional
 * references to missing rows are removed from the record instead and
 * reported as adjustments. A real database can hold any of these orphans,
 * because not every reference has a foreign key on every dialect and
 * installation. The number of rows a reader leaves out of a kind is
 * `countRows() - exported`. `byIds` never filters.
 */

import { sql, type Kysely, type RawBuilder } from "kysely";

import { isPostgres, listTableColumns } from "../../database/dialect-helpers.js";
import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { TransferError } from "../errors.js";
import { decodeContentRow, decodeRow, selectExportedColumns } from "../format/column-codec.js";
import {
	assertColumnCoverage,
	assertLoadedColumnCoverage,
	CONTENT_TABLE_PREFIX,
	contentColumnSpecs,
	getPortableTableSpecForKind,
	type ColumnSpec,
} from "../format/columns.js";
import {
	compareStreamOrder,
	syntheticId,
	isRecordOfKind,
	validateRecord,
	type RecordKind,
	type SitePackageRecord,
	type RecordOfKind,
	type StreamOrderKey,
} from "../format/kinds.js";
import { PORTABLE_SETTING_NAMES } from "../format/settings.js";
import type { ExportTransformationCode } from "../format/transformations.js";

type Db = Kysely<Database>;
type Row = Record<string, unknown>;

export interface ReadRow<K extends RecordKind> {
	key: StreamOrderKey;
	/** `null` when the row is left out of the package. */
	record: RecordOfKind<K> | null;
	/** In-record changes made while reading (e.g. a nulled avatar reference). */
	adjustments: ReadAdjustment[];
}

export interface ReadAdjustment {
	code: ExportTransformationCode;
	count: number;
}

export interface ReadPage<K extends RecordKind> {
	rows: Array<ReadRow<K>>;
	/** No rows follow the last row of this page. */
	done: boolean;
}

export interface KindReader<K extends RecordKind> {
	readonly kind: K;
	/** Up to `limit` rows after `after` in stream order. */
	page(after: StreamOrderKey | null, limit: number): Promise<ReadPage<K>>;
	/**
	 * Records by id, without export-only filtering. Missing ids are absent.
	 * `collections` maps entry ids to the collection each is looked up in;
	 * an entry id it does not name is looked up in every collection.
	 */
	byIds(
		ids: readonly string[],
		collections?: ReadonlyMap<string, string>,
	): Promise<Map<string, RecordOfKind<K>>>;
	/** Rows stored for this kind, or null when the kind has no table of its own. */
	countRows(): Promise<number | null>;
}

export interface ReaderOptions {
	/**
	 * Export operation whose hashed media (`_emdash_transfer_media_blobs`)
	 * defines the exported media set. Without it every media row is read and
	 * no reference is nulled.
	 */
	exportOperationId?: string;
	/** Blob digest per media id; media records carry it as `blob`. */
	mediaBlobs: (mediaIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;
	/** Whether comments exist for the principal reader. Defaults to true. */
	comments?: boolean;
}

// ── SQL helpers ─────────────────────────────────────────────────

function bytewiseExpr(db: Db, expr: RawBuilder<unknown>): RawBuilder<string> {
	return isPostgres(db) ? sql<string>`(${expr}) COLLATE "C"` : sql<string>`${expr}`;
}

function count(value: unknown): number {
	return Number(value ?? 0);
}

function invalidRecord(kind: RecordKind, id: string, field: string, reason: string): TransferError {
	return new TransferError("TRANSFER_EXPORT_ERROR", "Stored row does not form a valid record", {
		detail: { kind, id, field, reason },
	});
}

function toRecord<K extends RecordKind>(kind: K, raw: Row): RecordOfKind<K> {
	const result = validateRecord(kind, raw);
	if (!result.success) {
		const issue = result.issues[0];
		throw invalidRecord(
			kind,
			typeof raw.id === "string" ? raw.id : "",
			issue?.path ?? "",
			issue?.message ?? "invalid",
		);
	}
	return result.record;
}

function stringOf(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Rows of `table` whose group (`translation_group`, else `id`) is one of `groups`. */
async function existingGroups(
	db: Db,
	table: string,
	groups: readonly string[],
): Promise<Set<string>> {
	const found = new Set<string>();
	// Each value is bound twice.
	for (const batch of chunks([...new Set(groups)], Math.floor(SQL_BATCH_SIZE / 2))) {
		const result = await sql<{ id: string; translation_group: string | null }>`
			SELECT id, translation_group FROM ${sql.ref(table)}
			WHERE translation_group IN (${sql.join(batch)})
				OR (translation_group IS NULL AND id IN (${sql.join(batch)}))
		`.execute(db);
		for (const row of result.rows) found.add(row.translation_group ?? row.id);
	}
	return found;
}

async function collectionSlugs(db: Db): Promise<string[]> {
	const rows = await db.selectFrom("_emdash_collections").select("slug").execute();
	return rows.map((row) => row.slug).toSorted();
}

function contentTable(slug: string): string {
	validateIdentifier(slug, "collection slug");
	return `${CONTENT_TABLE_PREFIX}${slug}`;
}

/**
 * A collection slug as an SQL literal. Filters compare against every
 * collection slug; as bound parameters they exceed D1's 100-parameter limit
 * on sites with many collections.
 */
function slugLiteral(slug: string): RawBuilder<unknown> {
	validateIdentifier(slug, "collection slug");
	return sql.lit(slug);
}

interface FilterContext {
	db: Db;
	options: ReaderOptions;
	/** Every collection slug, sorted. */
	slugs: readonly string[];
}

const NEVER = sql<boolean>`1 = 0`;

function anyOf(parts: ReadonlyArray<RawBuilder<boolean>>): RawBuilder<boolean> {
	return parts.length === 0 ? NEVER : sql<boolean>`(${sql.join(parts, sql` OR `)})`;
}

/** An entry with id `id` exists in the content table of collection `collection`. */
function entryExists(
	context: FilterContext,
	collection: RawBuilder<unknown>,
	id: RawBuilder<unknown>,
): RawBuilder<boolean> {
	return anyOf(
		context.slugs.map(
			(slug) => sql<boolean>`(${collection} = ${slugLiteral(slug)} AND EXISTS (
				SELECT 1 FROM ${sql.ref(contentTable(slug))} AS __entry WHERE __entry.id = ${id}
			))`,
		),
	);
}

/** A row of `table` has translation group (or, without one, id) `group`. */
function groupExists(table: string, group: RawBuilder<unknown>): RawBuilder<boolean> {
	return sql<boolean>`EXISTS (
		SELECT 1 FROM ${sql.ref(table)} AS __grouped
		WHERE __grouped.translation_group = ${group}
			OR (__grouped.translation_group IS NULL AND __grouped.id = ${group})
	)`;
}

/** An entry of collection `collection` has translation group `group`. */
function entryGroupExists(
	context: FilterContext,
	collection: RawBuilder<unknown>,
	group: RawBuilder<unknown>,
): RawBuilder<boolean> {
	return anyOf(
		context.slugs.map(
			(slug) =>
				sql<boolean>`(${collection} = ${slugLiteral(slug)} AND ${groupExists(contentTable(slug), group)})`,
		),
	);
}

function col(table: string, column: string): RawBuilder<unknown> {
	return sql`${sql.ref(`${table}.${column}`)}`;
}

/**
 * Ids of `table` reachable from a root (`parentColumn IS NULL`) through rows
 * that each satisfy `valid`: the tree rows an export keeps.
 */
function treeIds(
	table: string,
	parentColumn: string,
	valid: RawBuilder<boolean>,
): RawBuilder<unknown> {
	return sql`(
		WITH RECURSIVE __kept(__node) AS (
			SELECT ${col(table, "id")} FROM ${sql.ref(table)}
			WHERE ${col(table, parentColumn)} IS NULL AND ${valid}
			UNION ALL
			SELECT ${col(table, "id")} FROM ${sql.ref(table)}
			INNER JOIN __kept ON ${col(table, parentColumn)} = __kept.__node
			WHERE ${valid}
		)
		SELECT __node FROM __kept
	)`;
}

function commentValid(context: FilterContext): RawBuilder<boolean> {
	return entryExists(
		context,
		col("_emdash_comments", "collection"),
		col("_emdash_comments", "content_id"),
	);
}

function revisionValid(context: FilterContext): RawBuilder<boolean> {
	return entryExists(context, col("revisions", "collection"), col("revisions", "entry_id"));
}

/** Media ids among `ids` that the export operation hashed. */
async function exportedMediaIds(
	db: Db,
	operationId: string,
	ids: readonly string[],
): Promise<Set<string>> {
	const found = new Set<string>();
	for (const batch of chunks([...new Set(ids)], SQL_BATCH_SIZE)) {
		const rows = await db
			.selectFrom("_emdash_transfer_media_blobs")
			.select("media_id")
			.where("operation_id", "=", operationId)
			.where("media_id", "in", batch)
			.execute();
		for (const row of rows) found.add(row.media_id);
	}
	return found;
}

// ── Table readers ───────────────────────────────────────────────

interface TransformContext {
	db: Db;
	options: ReaderOptions;
	/** True when reading pages for an export (not `byIds`). */
	paging: boolean;
}

interface TransformResult<K extends RecordKind = RecordKind> {
	records: Array<RecordOfKind<K> | null>;
	/** Per record, parallel to `records`; absent when nothing was adjusted. */
	adjustments?: Array<ReadAdjustment[]>;
}

type Transform = (
	records: SitePackageRecord[],
	context: TransformContext,
) => Promise<TransformResult>;

/** Adapt a transform written for one kind to the reader's record list. */
function forKind<K extends RecordKind>(
	kind: K,
	transform: (
		records: Array<RecordOfKind<K>>,
		context: TransformContext,
	) => Promise<TransformResult<K>>,
): Transform {
	return (records, context) => {
		const typed = records.filter((record): record is RecordOfKind<K> =>
			isRecordOfKind(record, kind),
		);
		if (typed.length !== records.length) throw new Error(`Expected only ${kind} records`);
		return transform(typed, context);
	};
}

interface TableReaderConfig {
	kind: RecordKind;
	table: string;
	/** Key expression; defaults to the `id` column. */
	key?: (db: Db) => RawBuilder<unknown>;
	/** Rows kept when paging. */
	filter?: (context: FilterContext) => RawBuilder<boolean> | null;
	/** Rows `countRows` counts (defaults to every row). */
	countFilter?: () => RawBuilder<boolean>;
	/** Tree kinds: parent column; pages are ordered by `(depth, id)`. */
	parentColumn?: string;
	/** Tree kinds: rows kept when paging; a row below a dropped row is dropped too. */
	treeValid?: (context: FilterContext) => RawBuilder<boolean>;
	/** Adds properties that do not come from columns, before validation. */
	prepare?: (raws: Row[], options: ReaderOptions) => Promise<void>;
	/** Post-processing of decoded records (may drop rows or change properties). */
	transform?: Transform;
}

class TableReader implements KindReader<RecordKind> {
	readonly kind: RecordKind;
	readonly #db: Db;
	readonly #config: TableReaderConfig;
	readonly #options: ReaderOptions;
	readonly #columns: Readonly<Record<string, ColumnSpec>>;
	#covered = false;
	#slugs: readonly string[] = [];

	constructor(db: Db, config: TableReaderConfig, options: ReaderOptions) {
		const spec = getPortableTableSpecForKind(config.kind);
		if (!spec) throw new Error(`No table for kind ${config.kind}`);
		this.kind = config.kind;
		this.#db = db;
		this.#config = config;
		this.#options = options;
		this.#columns = spec.columns;
	}

	private async ensureCoverage(): Promise<void> {
		if (this.#covered) return;
		await assertColumnCoverage(this.#db, this.#config.table);
		this.#slugs = await collectionSlugs(this.#db);
		this.#covered = true;
	}

	private keyExpr(): RawBuilder<unknown> {
		return this.#config.key?.(this.#db) ?? sql`${sql.ref(`${this.#config.table}.id`)}`;
	}

	private selectList(): RawBuilder<unknown> {
		return sql.join(selectExportedColumns(this.#db, this.#columns));
	}

	private decodeRaw(row: Row): Row {
		const properties = decodeRow(this.#db, this.#columns, row);
		const raw: Row = { kind: this.kind, ...properties };
		if (
			this.kind === "content_term" ||
			this.kind === "seo" ||
			this.kind === "byline_field_value" ||
			this.kind === "byline_field_group_value"
		) {
			raw.id = syntheticId(toSyntheticParts(this.kind, raw));
		}
		return raw;
	}

	private async decode(rows: Row[]): Promise<Array<SitePackageRecord>> {
		const raws = rows.map((row) => this.decodeRaw(row));
		await this.#config.prepare?.(raws, this.#options);
		return raws.map((raw) => toRecord(this.kind, raw));
	}

	private async finish(
		records: Array<SitePackageRecord>,
		paging: boolean,
	): Promise<TransformResult> {
		if (!this.#config.transform) return { records };
		return this.#config.transform(records, { db: this.#db, options: this.#options, paging });
	}

	async page(after: StreamOrderKey | null, limit: number): Promise<ReadPage<RecordKind>> {
		await this.ensureCoverage();
		const db = this.#db;
		const table = sql.ref(this.#config.table);
		const context: FilterContext = { db, options: this.#options, slugs: this.#slugs };
		const filter = this.#config.filter?.(context) ?? null;
		const conditions: Array<RawBuilder<unknown>> = [];
		if (filter) conditions.push(filter);

		let result: { rows: Row[] };
		if (this.#config.parentColumn) {
			const parent = sql.ref(`${this.#config.table}.${this.#config.parentColumn}`);
			const idRef = sql.ref(`${this.#config.table}.id`);
			const valid = this.#config.treeValid?.(context) ?? sql<boolean>`1 = 1`;
			if (after) {
				const depth = after.depth ?? 0;
				conditions.push(
					sql`(__tree.__level > ${depth} OR (__tree.__level = ${depth} AND ${bytewiseExpr(db, idRef)} > ${after.id}))`,
				);
			}
			const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
			result = await sql<Row>`
				WITH RECURSIVE __tree(__node, __level) AS (
					SELECT ${idRef}, 0 FROM ${table} WHERE ${parent} IS NULL AND ${valid}
					UNION ALL
					SELECT ${idRef}, __tree.__level + 1 FROM ${table}
					INNER JOIN __tree ON ${parent} = __tree.__node
					WHERE ${valid}
				)
				SELECT ${this.selectList()}, __tree.__level AS __depth
				FROM ${table} INNER JOIN __tree ON __tree.__node = ${idRef}
				${where}
				ORDER BY __tree.__level, ${bytewiseExpr(db, idRef)}
				LIMIT ${limit + 1}
			`.execute(db);
		} else {
			const key = this.keyExpr();
			if (after) conditions.push(sql`${bytewiseExpr(db, key)} > ${after.id}`);
			const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
			result = await sql<Row>`
				SELECT ${this.selectList()}
				FROM ${table}
				${where}
				ORDER BY ${bytewiseExpr(db, key)}
				LIMIT ${limit + 1}
			`.execute(db);
		}

		const done = result.rows.length <= limit;
		const rows = result.rows.slice(0, limit);
		const records = await this.decode(rows);
		const keys = rows.map((row, index) => {
			const id = records[index]?.id ?? "";
			return this.#config.parentColumn ? { id, depth: count(row.__depth) } : { id };
		});
		const transformed = await this.finish(records, true);
		return {
			rows: keys.map((key, index) => ({
				key,
				record: transformed.records[index] ?? null,
				adjustments: transformed.adjustments?.[index] ?? [],
			})),
			done,
		};
	}

	async byIds(ids: readonly string[]): Promise<Map<string, SitePackageRecord>> {
		await this.ensureCoverage();
		const db = this.#db;
		const result = new Map<string, SitePackageRecord>();
		for (const batch of chunks([...new Set(ids)], SQL_BATCH_SIZE)) {
			const rows = await sql<Row>`
				SELECT ${this.selectList()}
				FROM ${sql.ref(this.#config.table)}
				WHERE ${this.keyExpr()} IN (${sql.join(batch)})
			`.execute(db);
			const records = await this.decode(rows.rows);
			const transformed = await this.finish(records, false);
			for (const record of transformed.records) {
				if (record) result.set(record.id, record);
			}
		}
		return result;
	}

	async countRows(): Promise<number> {
		const filter = this.#config.countFilter?.() ?? null;
		const where = filter ? sql`WHERE ${filter}` : sql``;
		const result = await sql<{ n: unknown }>`
			SELECT COUNT(*) AS n FROM ${sql.ref(this.#config.table)} ${where}
		`.execute(this.#db);
		return count(result.rows[0]?.n);
	}
}

function toSyntheticParts(kind: RecordKind, raw: Row): Parameters<typeof syntheticId>[0] {
	const part = (name: string) => stringOf(raw[name]) ?? "";
	switch (kind) {
		case "content_term":
			return {
				kind,
				collection: part("collection"),
				entryGroup: part("entryGroup"),
				termGroup: part("termGroup"),
			};
		case "seo":
			return { kind, collection: part("collection"), entryId: part("entryId") };
		case "byline_field_value":
			return { kind, bylineId: part("bylineId"), fieldId: part("fieldId") };
		default:
			return {
				kind: "byline_field_group_value",
				bylineGroup: part("bylineGroup"),
				fieldId: part("fieldId"),
			};
	}
}

function concatKey(...parts: string[]): (db: Db) => RawBuilder<unknown> {
	return () =>
		sql.join(
			parts.flatMap((part, index) =>
				index === 0 ? [sql.ref(part)] : [sql.lit(":"), sql.ref(part)],
			),
			sql` || `,
		);
}

// ── Transforms ──────────────────────────────────────────────────

async function nullUnexportedMedia<K extends "byline" | "section">(
	records: Array<RecordOfKind<K>>,
	context: TransformContext,
	property: "avatarMediaId" | "previewMediaId",
): Promise<TransformResult<K>> {
	const operationId = context.options.exportOperationId;
	if (!operationId || !context.paging) return { records };
	const ids = records.flatMap((record) => {
		const value: unknown = Reflect.get(record, property);
		return typeof value === "string" ? [value] : [];
	});
	if (ids.length === 0) return { records };
	const exported = await exportedMediaIds(context.db, operationId, ids);
	const adjustments: Array<ReadAdjustment[]> = [];
	const next = records.map((record) => {
		const value: unknown = Reflect.get(record, property);
		if (typeof value !== "string" || exported.has(value)) {
			adjustments.push([]);
			return record;
		}
		adjustments.push([{ code: "avatar_nulled", count: 1 }]);
		const copy = { ...record };
		Reflect.deleteProperty(copy, property);
		return copy;
	});
	return { records: next, adjustments };
}

async function nullMissingFolders(
	records: Array<RecordOfKind<"media">>,
	context: TransformContext,
): Promise<TransformResult<"media">> {
	if (!context.paging) return { records };
	const ids = [...new Set(records.flatMap((r) => (r.folderId === undefined ? [] : [r.folderId])))];
	if (ids.length === 0) return { records };
	const found = new Set<string>();
	for (const batch of chunks(ids, SQL_BATCH_SIZE)) {
		const rows = await context.db
			.selectFrom("media_folders")
			.select("id")
			.where("id", "in", batch)
			.execute();
		for (const row of rows) found.add(row.id);
	}
	const adjustments: Array<ReadAdjustment[]> = [];
	const next = records.map((record) => {
		if (record.folderId === undefined || found.has(record.folderId)) {
			adjustments.push([]);
			return record;
		}
		adjustments.push([{ code: "orphan_reference_nulled", count: 1 }]);
		const { folderId: _missing, ...rest } = record;
		return rest;
	});
	return { records: next, adjustments };
}

async function filterTaxonomyCollections(
	records: Array<RecordOfKind<"taxonomy_def">>,
	context: TransformContext,
): Promise<TransformResult<"taxonomy_def">> {
	if (!context.paging) return { records };
	const slugs = new Set(await collectionSlugs(context.db));
	const adjustments: Array<ReadAdjustment[]> = [];
	const next = records.map((record) => {
		const kept = record.collections?.filter((slug) => slugs.has(slug));
		if (!record.collections || !kept || kept.length === record.collections.length) {
			adjustments.push([]);
			return record;
		}
		adjustments.push([
			{ code: "soft_orphan_dropped", count: record.collections.length - kept.length },
		]);
		return { ...record, collections: kept };
	});
	return { records: next, adjustments };
}

async function attachBlobs(raws: Row[], options: ReaderOptions): Promise<void> {
	const ids = raws.flatMap((raw) => (typeof raw.id === "string" ? [raw.id] : []));
	if (ids.length === 0) return;
	const blobs = await options.mediaBlobs(ids);
	for (const raw of raws) {
		const blob = typeof raw.id === "string" ? blobs.get(raw.id) : undefined;
		if (blob !== undefined) raw.blob = blob;
	}
}

// ── Reader table ────────────────────────────────────────────────

const PORTABLE_SETTINGS_FILTER = (): RawBuilder<boolean> =>
	sql<boolean>`${sql.ref("options.name")} IN (${sql.join(PORTABLE_SETTING_NAMES.map((name) => sql.lit(name)))})`;

const REDIRECT_FILTER = (): RawBuilder<boolean> => sql<boolean>`(
	_emdash_redirects.source_guard = 1
	OR (
		NOT EXISTS (
			SELECT 1 FROM _emdash_redirects AS guarded
			WHERE guarded.source = _emdash_redirects.source AND guarded.source_guard = 1
		)
		AND _emdash_redirects.id = (
			SELECT MIN(first.id) FROM _emdash_redirects AS first
			WHERE first.source = _emdash_redirects.source
		)
	)
)`;

const COLLECTION_SLUGS = sql`(SELECT slug FROM _emdash_collections)`;

function tableConfig(kind: RecordKind): TableReaderConfig {
	const spec = getPortableTableSpecForKind(kind);
	if (!spec) throw new Error(`No table for kind ${kind}`);
	return { kind, table: spec.table };
}

function configFor(kind: RecordKind): TableReaderConfig {
	switch (kind) {
		case "block_type_version":
			return {
				...tableConfig(kind),
				filter: () =>
					sql<boolean>`_emdash_block_type_versions.block_type_id IN (SELECT id FROM _emdash_block_types)`,
			};
		case "field":
			return {
				...tableConfig(kind),
				filter: () =>
					sql<boolean>`_emdash_fields.collection_id IN (SELECT id FROM _emdash_collections)`,
			};
		case "taxonomy_def":
			return {
				...tableConfig(kind),
				transform: forKind("taxonomy_def", filterTaxonomyCollections),
			};
		case "relation":
			return {
				...tableConfig(kind),
				filter: () => sql<boolean>`(
					_emdash_relations.parent_collection IN ${COLLECTION_SLUGS}
					AND _emdash_relations.child_collection IN ${COLLECTION_SLUGS}
				)`,
			};
		case "media":
			return {
				...tableConfig("media"),
				filter: ({ options }) =>
					options.exportOperationId === undefined
						? null
						: sql<boolean>`media.id IN (
							SELECT media_id FROM _emdash_transfer_media_blobs
							WHERE operation_id = ${options.exportOperationId}
						)`,
				prepare: attachBlobs,
				transform: forKind("media", nullMissingFolders),
			};
		case "term":
			return { ...tableConfig("term"), parentColumn: "parent_id" };
		case "comment":
			return { ...tableConfig("comment"), parentColumn: "parent_id", treeValid: commentValid };
		case "comment_reaction":
			return {
				...tableConfig(kind),
				filter: (context) =>
					sql<boolean>`_emdash_comment_reactions.comment_id IN ${treeIds(
						"_emdash_comments",
						"parent_id",
						commentValid(context),
					)}`,
			};
		case "menu_item":
			return {
				...tableConfig("menu_item"),
				parentColumn: "parent_id",
				treeValid: (context) => {
					const reference = col("_emdash_menu_items", "reference_id");
					return sql<boolean>`(
						_emdash_menu_items.menu_id IN (SELECT id FROM _emdash_menus)
						AND (
							${reference} IS NULL
							OR ${groupExists("taxonomies", reference)}
							OR ${anyOf(context.slugs.map((slug) => groupExists(contentTable(slug), reference)))}
						)
					)`;
				},
			};
		case "byline":
			return {
				...tableConfig("byline"),
				transform: forKind("byline", (records, context) =>
					nullUnexportedMedia(records, context, "avatarMediaId"),
				),
			};
		case "section":
			return {
				...tableConfig("section"),
				transform: forKind("section", (records, context) =>
					nullUnexportedMedia(records, context, "previewMediaId"),
				),
			};
		case "byline_field_value":
			return {
				...tableConfig(kind),
				key: concatKey("byline_id", "field_id"),
				filter: () => sql<boolean>`(
					_emdash_byline_field_values.byline_id IN (SELECT id FROM _emdash_bylines)
					AND _emdash_byline_field_values.field_id IN (SELECT id FROM _emdash_byline_fields)
				)`,
			};
		case "byline_field_group_value":
			return {
				...tableConfig(kind),
				key: concatKey("translation_group", "field_id"),
				filter: () => sql<boolean>`(
					${groupExists("_emdash_bylines", col("_emdash_byline_field_group_values", "translation_group"))}
					AND _emdash_byline_field_group_values.field_id IN (SELECT id FROM _emdash_byline_fields)
				)`,
			};
		case "revision":
			return { ...tableConfig(kind), filter: revisionValid };
		case "content_term":
			return {
				...tableConfig("content_term"),
				key: concatKey("collection", "entry_id", "taxonomy_id"),
				filter: (context) => sql<boolean>`(
					${entryGroupExists(context, col("content_taxonomies", "collection"), col("content_taxonomies", "entry_id"))}
					AND ${groupExists("taxonomies", col("content_taxonomies", "taxonomy_id"))}
				)`,
			};
		case "content_byline":
			return {
				...tableConfig(kind),
				filter: (context) => sql<boolean>`(
					${entryExists(context, col("_emdash_content_bylines", "collection_slug"), col("_emdash_content_bylines", "content_id"))}
					AND ${groupExists("_emdash_bylines", col("_emdash_content_bylines", "byline_id"))}
				)`,
			};
		case "content_reference":
			return {
				...tableConfig("content_reference"),
				filter: (context) => {
					const references = "_emdash_content_references";
					return sql<boolean>`EXISTS (
						SELECT 1 FROM _emdash_relations AS __relation
						WHERE (
							__relation.translation_group = ${col(references, "relation_group")}
							OR (__relation.translation_group IS NULL AND __relation.id = ${col(references, "relation_group")})
						)
						AND ${entryGroupExists(context, sql`__relation.parent_collection`, col(references, "parent_group"))}
						AND ${entryGroupExists(context, sql`__relation.child_collection`, col(references, "child_group"))}
					)`;
				},
			};
		case "seo":
			return {
				...tableConfig(kind),
				key: concatKey("collection", "content_id"),
				filter: (context) =>
					entryExists(context, col("_emdash_seo", "collection"), col("_emdash_seo", "content_id")),
			};
		case "widget":
			return {
				...tableConfig("widget"),
				filter: () => sql<boolean>`(
					_emdash_widgets.area_id IN (SELECT id FROM _emdash_widget_areas)
					AND (
						_emdash_widgets.menu_name IS NULL
						OR _emdash_widgets.menu_name IN (SELECT name FROM _emdash_menus)
					)
				)`,
			};
		case "redirect":
			return { ...tableConfig(kind), filter: REDIRECT_FILTER };
		case "setting":
			return {
				...tableConfig(kind),
				key: () => sql`${sql.ref("options.name")}`,
				filter: PORTABLE_SETTINGS_FILTER,
				countFilter: PORTABLE_SETTINGS_FILTER,
			};
		default:
			return tableConfig(kind);
	}
}

// ── Entries ─────────────────────────────────────────────────────

interface ContentCollection {
	slug: string;
	table: string;
	columns: Readonly<Record<string, ColumnSpec>>;
}

type FieldColumns = ReadonlyArray<{ slug: string; column_type: string }>;

class EntryReader implements KindReader<"entry"> {
	readonly kind = "entry";
	readonly #db: Db;
	#fields: Promise<ReadonlyMap<string, FieldColumns>> | null = null;
	readonly #collections = new Map<string, Promise<ContentCollection>>();

	constructor(db: Db) {
		this.#db = db;
	}

	/** Registered fields of every collection, by collection slug, in one query. */
	private fields(): Promise<ReadonlyMap<string, FieldColumns>> {
		this.#fields ??= this.#db
			.selectFrom("_emdash_collections")
			.leftJoin("_emdash_fields", "_emdash_fields.collection_id", "_emdash_collections.id")
			.select([
				"_emdash_collections.slug as collection",
				"_emdash_fields.slug as slug",
				"_emdash_fields.column_type as column_type",
			])
			.execute()
			.then((rows) => {
				const fields = new Map<string, Array<{ slug: string; column_type: string }>>();
				for (const row of rows) {
					const list = fields.get(row.collection) ?? [];
					if (row.slug !== null && row.column_type !== null) {
						list.push({ slug: row.slug, column_type: row.column_type });
					}
					fields.set(row.collection, list);
				}
				return fields;
			});
		return this.#fields;
	}

	private async slugs(): Promise<string[]> {
		return [...(await this.fields()).keys()].toSorted();
	}

	/** A collection's table and column specs, loaded once and checked for coverage. */
	private collection(slug: string): Promise<ContentCollection> {
		let pending = this.#collections.get(slug);
		if (!pending) {
			pending = (async () => {
				const table = contentTable(slug);
				const fields = (await this.fields()).get(slug) ?? [];
				const tableColumns = await listTableColumns(this.#db, table);
				const columns = contentColumnSpecs(fields, tableColumns);
				assertLoadedColumnCoverage(table, columns, tableColumns);
				return { slug, table, columns };
			})();
			this.#collections.set(slug, pending);
		}
		return pending;
	}

	private async collections(): Promise<ContentCollection[]> {
		const result = [];
		for (const slug of await this.slugs()) result.push(await this.collection(slug));
		return result;
	}

	private decode(collection: ContentCollection, row: Row): RecordOfKind<"entry"> {
		const { properties, fields } = decodeContentRow(this.#db, collection.columns, row);
		return toRecord("entry", {
			kind: "entry",
			collection: collection.slug,
			...properties,
			fields,
		});
	}

	private selectList(collection: ContentCollection): RawBuilder<unknown> {
		return sql.join(selectExportedColumns(this.#db, collection.columns));
	}

	async page(after: StreamOrderKey | null, limit: number): Promise<ReadPage<"entry">> {
		const db = this.#db;
		const merged: Array<RecordOfKind<"entry">> = [];
		for (const collection of await this.collections()) {
			const idRef = sql.ref(`${collection.table}.id`);
			const where = after ? sql`WHERE ${bytewiseExpr(db, idRef)} > ${after.id}` : sql``;
			const result = await sql<Row>`
				SELECT ${this.selectList(collection)}
				FROM ${sql.ref(collection.table)}
				${where}
				ORDER BY ${bytewiseExpr(db, idRef)}
				LIMIT ${limit + 1}
			`.execute(db);
			for (const row of result.rows) merged.push(this.decode(collection, row));
		}
		merged.sort((a, b) => compareStreamOrder("entry", a, b));
		const page = merged.slice(0, limit);
		const nulled = await this.nullMissingReferences(page);
		return {
			rows: nulled.map(({ record, adjustments }) => ({
				key: { id: record.id },
				record,
				adjustments,
			})),
			done: merged.length <= limit,
		};
	}

	/**
	 * Remove revision pointers to revisions an export leaves out and primary
	 * bylines that do not exist, keeping the entry.
	 */
	private async nullMissingReferences(
		records: Array<RecordOfKind<"entry">>,
	): Promise<Array<{ record: RecordOfKind<"entry">; adjustments: ReadAdjustment[] }>> {
		const db = this.#db;
		const revisionIds = [
			...new Set(
				records.flatMap((record) =>
					[record.liveRevisionId, record.draftRevisionId].filter(
						(id): id is string => id !== undefined,
					),
				),
			),
		];
		const revisions = new Set<string>();
		const context: FilterContext = {
			db,
			options: { mediaBlobs: async () => new Map() },
			slugs: await this.slugs(),
		};
		for (const batch of chunks(revisionIds, SQL_BATCH_SIZE)) {
			const rows = await sql<{ id: string }>`
				SELECT id FROM revisions
				WHERE id IN (${sql.join(batch)}) AND ${revisionValid(context)}
			`.execute(db);
			for (const row of rows.rows) revisions.add(row.id);
		}
		const bylineGroups = await existingGroups(
			db,
			"_emdash_bylines",
			records.flatMap((record) =>
				record.primaryBylineGroup === undefined ? [] : [record.primaryBylineGroup],
			),
		);
		return records.map((record) => {
			const next: Record<string, unknown> = { ...record };
			let nulled = 0;
			for (const property of ["liveRevisionId", "draftRevisionId"] as const) {
				const id = record[property];
				if (id !== undefined && !revisions.has(id)) {
					delete next[property];
					nulled++;
				}
			}
			if (record.primaryBylineGroup !== undefined && !bylineGroups.has(record.primaryBylineGroup)) {
				delete next.primaryBylineGroup;
				nulled++;
			}
			if (nulled === 0) return { record, adjustments: [] };
			return {
				record: toRecord("entry", next),
				adjustments: [{ code: "orphan_reference_nulled", count: nulled }],
			};
		});
	}

	async byIds(
		ids: readonly string[],
		collections?: ReadonlyMap<string, string>,
	): Promise<Map<string, RecordOfKind<"entry">>> {
		const slugs = new Set(await this.slugs());
		const bySlug = new Map<string, string[]>();
		const anywhere: string[] = [];
		for (const id of new Set(ids)) {
			const slug = collections?.get(id);
			if (slug === undefined) {
				anywhere.push(id);
			} else if (slugs.has(slug)) {
				const list = bySlug.get(slug) ?? [];
				list.push(id);
				bySlug.set(slug, list);
			}
		}
		if (anywhere.length > 0) {
			for (const slug of slugs) bySlug.set(slug, [...(bySlug.get(slug) ?? []), ...anywhere]);
		}

		const result = new Map<string, RecordOfKind<"entry">>();
		for (const [slug, slugIds] of bySlug) {
			const collection = await this.collection(slug);
			for (const batch of chunks(slugIds, SQL_BATCH_SIZE)) {
				const rows = await sql<Row>`
					SELECT ${this.selectList(collection)}
					FROM ${sql.ref(collection.table)}
					WHERE ${sql.ref(`${collection.table}.id`)} IN (${sql.join(batch)})
				`.execute(this.#db);
				for (const row of rows.rows) {
					const record = this.decode(collection, row);
					result.set(record.id, record);
				}
			}
		}
		return result;
	}

	async countRows(): Promise<number> {
		let total = 0;
		for (const collection of await this.collections()) {
			const result = await sql<{ n: unknown }>`
				SELECT COUNT(*) AS n FROM ${sql.ref(collection.table)}
			`.execute(this.#db);
			total += count(result.rows[0]?.n);
		}
		return total;
	}
}

// ── Principals ──────────────────────────────────────────────────

interface PrincipalSource {
	table: string;
	column: string;
	filter?: RawBuilder<boolean>;
}

/**
 * Principals are the origin users referenced by exported rows. Nothing but
 * the id, name, and email of a user ever leaves the `users` table.
 */
class PrincipalReader implements KindReader<"principal"> {
	readonly kind = "principal";
	readonly #db: Db;
	readonly #options: ReaderOptions;

	constructor(db: Db, options: ReaderOptions) {
		this.#db = db;
		this.#options = options;
	}

	private async sources(): Promise<PrincipalSource[]> {
		const sources: PrincipalSource[] = [];
		const slugs = await collectionSlugs(this.#db);
		const context: FilterContext = { db: this.#db, options: this.#options, slugs };
		for (const slug of slugs) {
			sources.push({ table: contentTable(slug), column: "author_id" });
		}
		sources.push({ table: "revisions", column: "author_id", filter: revisionValid(context) });
		const operationId = this.#options.exportOperationId;
		sources.push({
			table: "media",
			column: "author_id",
			filter:
				operationId === undefined
					? undefined
					: sql<boolean>`media.id IN (
						SELECT media_id FROM _emdash_transfer_media_blobs WHERE operation_id = ${operationId}
					)`,
		});
		sources.push({ table: "_emdash_bylines", column: "user_id" });
		if (this.#options.comments ?? true) {
			sources.push({
				table: "_emdash_comments",
				column: "author_user_id",
				filter: sql<boolean>`_emdash_comments.id IN ${treeIds(
					"_emdash_comments",
					"parent_id",
					commentValid(context),
				)}`,
			});
		}
		return sources;
	}

	async page(after: StreamOrderKey | null, limit: number): Promise<ReadPage<"principal">> {
		const db = this.#db;
		const ids = new Set<string>();
		for (const source of await this.sources()) {
			const column = sql.ref(`${source.table}.${source.column}`);
			const conditions: Array<RawBuilder<unknown>> = [sql`${column} IS NOT NULL`];
			if (after) conditions.push(sql`${bytewiseExpr(db, column)} > ${after.id}`);
			if (source.filter) conditions.push(source.filter);
			const result = await sql<{ id: string }>`
				SELECT ${column} AS id FROM ${sql.ref(source.table)}
				WHERE ${sql.join(conditions, sql` AND `)}
				GROUP BY ${column}
				ORDER BY ${bytewiseExpr(db, column)}
				LIMIT ${limit + 1}
			`.execute(db);
			for (const row of result.rows) ids.add(row.id);
		}
		const sorted = [...ids].toSorted((a, b) =>
			compareStreamOrder("principal", { id: a }, { id: b }),
		);
		const pageIds = sorted.slice(0, limit);
		const records = await this.byIds(pageIds);
		return {
			rows: pageIds.map((id) => ({
				key: { id },
				record:
					records.get(id) ?? toRecord("principal", { kind: "principal", id, displayName: "" }),
				adjustments: [],
			})),
			done: sorted.length <= limit,
		};
	}

	async byIds(ids: readonly string[]): Promise<Map<string, RecordOfKind<"principal">>> {
		const result = new Map<string, RecordOfKind<"principal">>();
		for (const batch of chunks([...new Set(ids)], SQL_BATCH_SIZE)) {
			const rows = await this.#db
				.selectFrom("users")
				.select(["id", "name", "email"])
				.where("id", "in", batch)
				.execute();
			for (const row of rows) {
				result.set(
					row.id,
					toRecord("principal", {
						kind: "principal",
						id: row.id,
						displayName: row.name || row.email,
						email: row.email,
					}),
				);
			}
		}
		return result;
	}

	async countRows(): Promise<null> {
		return null;
	}
}

// ── Factory ─────────────────────────────────────────────────────

export function createReader(
	db: Db,
	kind: RecordKind,
	options: ReaderOptions,
): KindReader<RecordKind> {
	if (kind === "entry") return new EntryReader(db);
	if (kind === "principal") return new PrincipalReader(db, options);
	return new TableReader(db, configFor(kind), options);
}
