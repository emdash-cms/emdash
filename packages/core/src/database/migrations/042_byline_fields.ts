import type { Kysely } from "kysely";
import { sql } from "kysely";

import { currentTimestamp } from "../dialect-helpers.js";

/**
 * Byline custom fields (Discussion #1174). Adds three tables and a
 * version-counter row in `options`. Purely additive: no change to
 * `_emdash_bylines` columns landed by migration 040, no change to
 * `_emdash_content_bylines`.
 *
 * Storage model (D11 in the design spec):
 *
 * - `_emdash_byline_fields` — definitions. One row per registered field.
 * - `_emdash_byline_field_values` — translatable values, keyed by
 *   `(byline_id, field_id)`. One value per locale variant of a byline.
 * - `_emdash_byline_field_group_values` — non-translatable values, keyed
 *   by `(translation_group, field_id)`. One value shared across every
 *   locale variant of the byline's translation group.
 *
 * The per-field `translatable` flag (column on `_emdash_byline_fields`)
 * decides which value table a field writes to. The split is at the
 * storage level rather than per-row so a single SELECT … IN per locale
 * bucket suffices for batched hydration (see Phase 3 of the PR plan).
 *
 * `options('byline_fields_version', '0')` is the version counter the
 * field-definitions cache reads (Phase 3). Every mutation on
 * `_emdash_byline_fields` bumps this row; cached defs invalidate on a
 * mismatch. Storing it in `options` (the same table `settings/index.ts`
 * uses) means we get the request-cache + persisted-version pattern for
 * free — no new infrastructure.
 *
 * Idempotency: every `CREATE TABLE` and `CREATE INDEX` uses
 * `.ifNotExists()`, so a partial prior run (a crash mid-migration, retried
 * after the runner's race-recovery path or after a manual fix) re-applies
 * cleanly — including any indexes that landed in the failed pass after the
 * table itself. A coarse table-level guard would skip the index step if the
 * table existed but indexes didn't (the realistic crash window between
 * `CREATE TABLE` and the next `CREATE INDEX`). The runner records applied
 * migrations only after a successful pass, so a crashed-then-retried `up()`
 * is the normal recovery path here.
 *
 * D1 has no transactions — the schema builder and `INSERT` for the
 * version row execute one statement at a time. Order matters: parent
 * tables first (`_emdash_byline_fields`), then the value tables that
 * reference it. If `down()` runs after a partial `up()`, missing tables
 * are tolerated (`DROP TABLE IF EXISTS`).
 */

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_byline_fields")
		.ifNotExists()
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("slug", "text", (col) => col.notNull().unique())
		.addColumn("label", "text", (col) => col.notNull())
		.addColumn("type", "text", (col) => col.notNull())
		.addColumn("required", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("translatable", "integer", (col) => col.notNull().defaultTo(1))
		.addColumn("validation", "text") // JSON: { options?: string[] }
		.addColumn("sort_order", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.execute();

	await db.schema
		.createIndex("idx__emdash_byline_fields_sort_order")
		.ifNotExists()
		.on("_emdash_byline_fields")
		.column("sort_order")
		.execute();

	await db.schema
		.createTable("_emdash_byline_field_values")
		.ifNotExists()
		.addColumn("byline_id", "text", (col) =>
			col.notNull().references("_emdash_bylines.id").onDelete("cascade"),
		)
		.addColumn("field_id", "text", (col) =>
			col.notNull().references("_emdash_byline_fields.id").onDelete("cascade"),
		)
		.addColumn("value", "text") // JSON-encoded CustomFieldValue
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addPrimaryKeyConstraint("_emdash_byline_field_values_pk", ["byline_id", "field_id"])
		.execute();

	await db.schema
		.createIndex("idx__emdash_byline_field_values_byline")
		.ifNotExists()
		.on("_emdash_byline_field_values")
		.column("byline_id")
		.execute();
	await db.schema
		.createIndex("idx__emdash_byline_field_values_field")
		.ifNotExists()
		.on("_emdash_byline_field_values")
		.column("field_id")
		.execute();

	await db.schema
		.createTable("_emdash_byline_field_group_values")
		.ifNotExists()
		.addColumn("translation_group", "text", (col) => col.notNull())
		.addColumn("field_id", "text", (col) =>
			col.notNull().references("_emdash_byline_fields.id").onDelete("cascade"),
		)
		.addColumn("value", "text") // JSON-encoded CustomFieldValue
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addPrimaryKeyConstraint("_emdash_byline_field_group_values_pk", [
			"translation_group",
			"field_id",
		])
		.execute();

	await db.schema
		.createIndex("idx__emdash_byline_field_group_values_group")
		.ifNotExists()
		.on("_emdash_byline_field_group_values")
		.column("translation_group")
		.execute();
	await db.schema
		.createIndex("idx__emdash_byline_field_group_values_field")
		.ifNotExists()
		.on("_emdash_byline_field_group_values")
		.column("field_id")
		.execute();

	// Version-counter row read by the field-definitions cache (Phase 3).
	// `options.value` stores JSON, so the initial counter is the JSON literal
	// `0`. `INSERT … ON CONFLICT DO NOTHING` so a retry after a crash that
	// landed the row but failed later in the migration does not double-insert.
	await sql`
		INSERT INTO options (name, value) VALUES ('byline_fields_version', '0')
		ON CONFLICT (name) DO NOTHING
	`.execute(db);
}

/**
 * Reverses the schema additions and removes the version-counter row.
 * Used by the test suite and by `rollbackMigration`; the runner itself
 * never invokes `down()` automatically.
 *
 * The drops are unconditional `IF EXISTS` so a `down()` after a partial
 * `up()` (only one or two tables landed) still settles the database back
 * to its pre-042 state.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
	// Child tables first to avoid FK reference issues on Postgres. SQLite +
	// D1 accept either order with `IF EXISTS`, but explicit ordering keeps
	// the dialects parity-safe.
	await db.schema.dropTable("_emdash_byline_field_group_values").ifExists().execute();
	await db.schema.dropTable("_emdash_byline_field_values").ifExists().execute();
	await db.schema.dropTable("_emdash_byline_fields").ifExists().execute();
	await sql`DELETE FROM options WHERE name = 'byline_fields_version'`.execute(db);
}
