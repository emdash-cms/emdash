import type { Kysely } from "kysely";
import { sql } from "kysely";

import { columnExists, listTablesLike } from "../dialect-helpers.js";
import { validateIdentifier } from "../validate.js";

/**
 * Denormalize the filter + sort columns from `ec_*` onto `content_taxonomies`
 * and mirror `ec_*`'s composite sort indexes onto the pivot (#1834).
 *
 * A taxonomy-filtered listing used to apply the term filter as a correlated
 * `EXISTS` on `SELECT * FROM ec_<collection> … ORDER BY … LIMIT ?`. The pivot
 * carried only `(collection, entry_id, taxonomy_id)`, so the filter
 * (`deleted_at`, `status`, `locale`) and the sort (`published_at`/`created_at`)
 * could only be evaluated on the `ec_*` row. On stats-blind SQLite/D1 a
 * selective term never fills the `LIMIT`, so the query walked the whole
 * collection (~75k D1 rows read for a one-row page).
 *
 * Copying those columns onto the pivot and indexing them keyed by
 * `(taxonomy_id, collection, …)` lets the loader seek the term and walk a
 * sort-ordered pivot index, short-circuiting on `LIMIT`, then touch `ec_*` only
 * by primary key to hydrate the page.
 *
 * The columns are advisory (D1 has no transactions; the write-path re-stamp is
 * non-atomic), so the read path re-checks the real predicates on the joined
 * `ec_*` row — see loader.ts. `updated_at` is deliberately not denormalized: it
 * moves on every edit and is seldom a public sort, so its write cost outweighs
 * its read value; `updated_at`-sorted taxonomy listings temp-sort instead.
 *
 * Order matters: add the columns, backfill, THEN build the indexes so each
 * index is built once over populated data rather than maintained through the
 * backfill `UPDATE`.
 *
 * Forward-only.
 */

const DENORM_COLUMNS = [
	"status",
	"scheduled_at",
	"deleted_at",
	"locale",
	"published_at",
	"created_at",
] as const;

// `entry_id DESC` (not ASC) matters: the listing orders `<sort> DESC, entry_id
// DESC` (the common case), and a DESC tiebreaker lets SQLite satisfy the whole
// ORDER BY from the index — no temp B-tree, clean early-`LIMIT`. An ASC
// tiebreaker forces `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`, which buffers
// a whole equal-`sortval` block (e.g. a bulk import sharing one timestamp)
// before emitting. `DESC` also serves the rarer ASC listing via a backward
// index scan. Mirrors `ec_*`'s `(deleted_at, [locale,] <sort> DESC, id DESC)`.
const INDEXES: { name: string; columns: string }[] = [
	{
		name: "idx_content_taxonomies_pub",
		columns: "taxonomy_id, collection, deleted_at, published_at DESC, entry_id DESC",
	},
	{
		name: "idx_content_taxonomies_crt",
		columns: "taxonomy_id, collection, deleted_at, created_at DESC, entry_id DESC",
	},
	{
		name: "idx_content_taxonomies_loc_pub",
		columns: "taxonomy_id, collection, deleted_at, locale, published_at DESC, entry_id DESC",
	},
	{
		name: "idx_content_taxonomies_loc_crt",
		columns: "taxonomy_id, collection, deleted_at, locale, created_at DESC, entry_id DESC",
	},
];

export async function up(db: Kysely<unknown>): Promise<void> {
	// 1. Add the six denormalized columns (all nullable, no default). Guarded so
	//    a partial apply — or a re-run after a mid-migration failure — can retry
	//    (`ALTER TABLE ADD COLUMN` is not itself idempotent on either dialect).
	for (const column of DENORM_COLUMNS) {
		if (await columnExists(db, "content_taxonomies", column)) continue;
		await sql`
			ALTER TABLE content_taxonomies ADD COLUMN ${sql.ref(column)} TEXT
		`.execute(db);
	}

	// 2. Backfill from each content table by primary key. Drive from the actual
	//    `ec_*` tables (not `_emdash_collections`) so collections whose table was
	//    dropped are skipped naturally; the pivot's `collection` value is the
	//    slug, i.e. the table name without its `ec_` prefix.
	const tableNames = await listTablesLike(db, "ec_%");
	for (const tableName of tableNames) {
		validateIdentifier(tableName, "content table name");
		const slug = tableName.slice("ec_".length);
		await sql`
			UPDATE content_taxonomies
			SET (status, scheduled_at, deleted_at, locale, published_at, created_at) = (
				SELECT status, scheduled_at, deleted_at, locale, published_at, created_at
				FROM ${sql.ref(tableName)}
				WHERE ${sql.ref(tableName)}.id = content_taxonomies.entry_id
			)
			WHERE collection = ${slug}
		`.execute(db);
	}

	// 3. Build the composite sort indexes over the now-populated columns.
	for (const index of INDEXES) {
		await sql`
			CREATE INDEX IF NOT EXISTS ${sql.ref(index.name)}
			ON content_taxonomies (${sql.raw(index.columns)})
		`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	for (const index of INDEXES) {
		await sql`DROP INDEX IF EXISTS ${sql.ref(index.name)}`.execute(db);
	}
	for (const column of DENORM_COLUMNS) {
		await sql`
			ALTER TABLE content_taxonomies DROP COLUMN ${sql.ref(column)}
		`.execute(db);
	}
}
