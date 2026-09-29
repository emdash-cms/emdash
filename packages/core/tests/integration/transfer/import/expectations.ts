/**
 * Independent checks of an imported target: raw `SELECT *` of every portable
 * table, decoded with a test-local codec, compared with the golden records
 * after the plan's declared transformations and with media placeholders
 * replaced by the storage keys the target actually holds.
 */

import { sql, type Kysely } from "kysely";
import { expect } from "vitest";

import type { Database } from "../../../../src/database/types.js";
import { canonicalJson } from "../../../../src/transfer/format/canonical.js";
import {
	CONTENT_TABLE_COLUMNS,
	getPortableTableSpecForKind,
	type ColumnSpec,
} from "../../../../src/transfer/format/columns.js";
import {
	IMPORT_STAGE_KINDS,
	type RecordKind,
	type SitePackageRecord,
} from "../../../../src/transfer/format/kinds.js";
import { relativizePlaceholderUrls } from "../../../../src/transfer/format/media-refs.js";
import type { SiteImportPlan } from "../../../../src/transfer/format/plan.js";
import { applyTransformations } from "../../../../src/transfer/format/transformations.js";
import type { GoldenPackage } from "../../../utils/transfer/golden-package.js";

type Row = Record<string, unknown>;

const IMPORTED_KINDS: RecordKind[] = Object.values(IMPORT_STAGE_KINDS).flat();

function decode(value: unknown, spec: Extract<ColumnSpec, { property: string }>): unknown {
	if (value === null || value === undefined) return undefined;
	switch (spec.codec) {
		case "boolean":
			return Number(value) === 1;
		case "integer":
		case "real":
			return Number(value);
		case "json":
			return typeof value === "string" ? JSON.parse(value) : value;
		case "text":
			return typeof value === "string" ? value : JSON.stringify(value);
	}
}

function decodeRow(columns: Readonly<Record<string, ColumnSpec>>, row: Row): Row {
	const record: Row = {};
	for (const [column, spec] of Object.entries(columns)) {
		if (!("property" in spec)) continue;
		const value = decode(row[column], spec);
		if (value !== undefined) record[spec.property] = value;
	}
	return record;
}

async function selectAll(db: Kysely<Database>, table: string): Promise<Row[]> {
	return (await sql<Row>`SELECT * FROM ${sql.ref(table)}`.execute(db)).rows;
}

export async function mediaKeys(db: Kysely<Database>): Promise<Map<string, string>> {
	const rows = await db.selectFrom("media").select(["id", "storage_key"]).execute();
	return new Map(rows.map((row) => [row.id, row.storage_key]));
}

function resolvePlaceholders<T>(value: T, keys: ReadonlyMap<string, string>): T {
	const text = relativizePlaceholderUrls(canonicalJson(value)).replace(
		/emdash-media:([0-9A-Za-z_-]+)/g,
		(_match, id: string) => keys.get(id) ?? `MISSING:${id}`,
	);
	return JSON.parse(text) as T;
}

/** Package record → the record decoded from the target, per the plan. */
export function expectedRecord(
	record: SitePackageRecord,
	plan: SiteImportPlan,
	keys: ReadonlyMap<string, string>,
	fieldColumnTypes: ReadonlyMap<string, ReadonlyMap<string, "TEXT" | "REAL" | "INTEGER" | "JSON">>,
): Row {
	const transformed = applyTransformations(record, plan, { fieldColumnTypes });
	const { kind: _kind, ...rest } = resolvePlaceholders(transformed, keys) as Row;
	return rest;
}

function sortById(rows: Row[]): Row[] {
	return rows.toSorted((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * Assert every imported table equals the golden records modulo the plan.
 * Returns the materialized inferred credit rows (not package records).
 */
export async function expectTargetMatchesGolden(
	db: Kysely<Database>,
	golden: GoldenPackage,
	plan: SiteImportPlan,
	options: { searchConfigFinal?: boolean } = {},
): Promise<Row[]> {
	const keys = await mediaKeys(db);
	const fieldColumnTypes = new Map<string, Map<string, "TEXT" | "REAL" | "INTEGER" | "JSON">>();
	for (const field of golden.records.field) {
		if (field.kind !== "field") continue;
		const collection = golden.records.collection.find((c) => c.id === field.collectionId);
		if (!collection || collection.kind !== "collection") continue;
		const map = fieldColumnTypes.get(collection.slug) ?? new Map();
		map.set(field.slug, field.columnType);
		fieldColumnTypes.set(collection.slug, map);
	}
	let inferred: Row[] = [];

	for (const kind of IMPORTED_KINDS) {
		const records = golden.records[kind];
		if (kind === "entry") {
			for (const [slug, types] of fieldColumnTypes) {
				const columns: Record<string, ColumnSpec> = { ...CONTENT_TABLE_COLUMNS };
				const rows = (await selectAll(db, `ec_${slug}`)).map((row) => {
					const decoded = decodeRow(columns, row);
					const fields: Row = {};
					for (const [field, type] of types) {
						const value = decode(row[field], {
							class: "field",
							property: field,
							codec:
								type === "JSON"
									? "json"
									: type === "TEXT"
										? "text"
										: type === "REAL"
											? "real"
											: "integer",
						});
						if (value !== undefined) fields[field] = value;
					}
					return { ...decoded, collection: slug, fields };
				});
				const expected = records
					.filter((record) => record.kind === "entry" && record.collection === slug)
					.map((record) => expectedRecord(record, plan, keys, fieldColumnTypes));
				expect(sortById(rows)).toEqual(sortById(expected));
			}
			continue;
		}

		const spec = getPortableTableSpecForKind(kind);
		if (!spec) throw new Error(`No table for ${kind}`);
		let rows = (await selectAll(db, spec.table)).map((row) => decodeRow(spec.columns, row));
		let expected = records.map((record) => {
			const { id, blob: _blob, ...rest } = expectedRecord(record, plan, keys, fieldColumnTypes);
			return kind === "content_term" ||
				kind === "seo" ||
				kind === "byline_field_value" ||
				kind === "byline_field_group_value"
				? rest
				: { id, ...rest };
		});
		if (kind === "content_byline") {
			inferred = rows.filter((row) => String(row.id).startsWith("inferred:"));
			rows = rows.filter((row) => !String(row.id).startsWith("inferred:"));
		}
		if (kind === "collection" && options.searchConfigFinal === false) {
			rows = rows.map(({ searchConfig: _ignored, ...rest }) => rest);
			expected = expected.map(({ searchConfig: _ignored, ...rest }) => rest);
		}
		if (kind === "setting") {
			const names = new Set(records.map((record) => record.id));
			rows = rows.filter((row) => names.has(String(row.id)));
		}
		const canonical = (list: Row[]) => list.map((row) => canonicalJson(row)).toSorted();
		expect(canonical(rows), `table ${spec.table}`).toEqual(canonical(expected));
	}
	return inferred;
}

/**
 * Portable table contents, for comparing two imports of the same package.
 * Omits values that differ per target or per operation: random
 * revisions, reaction voter hashes (keyed by the operation's secret), the
 * site id, and the byline-fields version counter.
 */
export async function dumpTarget(db: Kysely<Database>): Promise<Record<string, string[]>> {
	const tables = [
		...IMPORTED_KINDS.flatMap((kind) => {
			const spec = getPortableTableSpecForKind(kind);
			return spec ? [spec.table] : [];
		}),
		"_emdash_fields",
		"_emdash_collections",
		"ec_posts",
		"ec_pages",
		"_emdash_transfer_identity_map",
	];
	const volatile = new Set(["config_revision", "revision", "operation_id", "voter_hash"]);
	const perTarget = new Set(["emdash:site_id", "byline_fields_version"]);
	const dump: Record<string, string[]> = {};
	for (const table of new Set(tables)) {
		dump[table] = (await selectAll(db, table))
			.filter((row) => !(table === "options" && perTarget.has(String(row.name))))
			.map((row) =>
				canonicalJson(
					Object.fromEntries(
						Object.entries(row)
							.filter(
								([column]) =>
									!volatile.has(column) &&
									!(table === "_emdash_transfer_identity_map" && column === "created_at"),
							)
							.map(([column, value]) => [column, value === undefined ? null : value]),
					),
				),
			)
			.toSorted();
	}
	return dump;
}
