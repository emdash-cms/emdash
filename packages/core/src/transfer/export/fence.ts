/**
 * Optimistic-read fence for an export: per portable table, the row count,
 * the latest `updated_at` (or `created_at`), and the largest id. A write that
 * changes none of these (an in-place edit of a table without `updated_at`) is
 * caught by the operation's `write_epoch`, which fenced writes bump.
 */

import { sql, type Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import { CONTENT_TABLE_PREFIX, PORTABLE_TABLES } from "../format/columns.js";
import type { ExportFence } from "../ops/states.js";

type Db = Kysely<Database>;

interface FencedTable {
	table: string;
	changed: string | null;
	id: string | null;
}

async function fencedTables(db: Db): Promise<FencedTable[]> {
	const tables: FencedTable[] = PORTABLE_TABLES.map((spec) => ({
		table: spec.table,
		changed: Object.hasOwn(spec.columns, "updated_at")
			? "updated_at"
			: Object.hasOwn(spec.columns, "created_at")
				? "created_at"
				: null,
		id: Object.hasOwn(spec.columns, "id") ? "id" : null,
	}));
	tables.push({ table: "users", changed: "updated_at", id: "id" });
	const collections = await db
		.selectFrom("_emdash_collections")
		.select("slug")
		.orderBy("slug")
		.execute();
	for (const { slug } of collections) {
		validateIdentifier(slug, "collection slug");
		tables.push({ table: `${CONTENT_TABLE_PREFIX}${slug}`, changed: "updated_at", id: "id" });
	}
	return tables.toSorted((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0));
}

function optionalText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint") return String(value);
	if (value instanceof Date) return value.toISOString();
	return undefined;
}

export async function captureFence(db: Db, writeEpoch: number): Promise<ExportFence> {
	const result: ExportFence = { writeEpoch, tables: [] };
	for (const table of await fencedTables(db)) {
		const changed = table.changed ? sql`MAX(${sql.ref(table.changed)})` : sql`NULL`;
		const id = table.id ? sql`MAX(${sql.ref(table.id)})` : sql`NULL`;
		const row = await sql<{ n: unknown; changed: unknown; id: unknown }>`
			SELECT COUNT(*) AS n, ${changed} AS changed, ${id} AS id FROM ${sql.ref(table.table)}
		`.execute(db);
		const values = row.rows[0];
		result.tables.push({
			table: table.table,
			count: Number(values?.n ?? 0),
			maxChanged: optionalText(values?.changed),
			maxId: optionalText(values?.id),
		});
	}
	return result;
}

export function fencesEqual(a: ExportFence, b: ExportFence): boolean {
	if (a.writeEpoch !== b.writeEpoch || a.tables.length !== b.tables.length) return false;
	return a.tables.every((table, index) => {
		const other = b.tables[index];
		return (
			other !== undefined &&
			other.table === table.table &&
			other.count === table.count &&
			other.maxChanged === table.maxChanged &&
			other.maxId === table.maxId
		);
	});
}
