import type { Kysely } from "kysely";

/**
 * Restore `idx_taxonomies_parent` on `taxonomies(parent_id)` (#1665).
 *
 * Migration 015 created this index, but 036's SQLite table rebuild
 * (`taxonomies_new` → drop → rename) dropped every index attached to the old
 * table and only recreated `name`/`locale`/`translation_group`. The parent
 * index — which backs hierarchical (parent/child) lookups — was silently lost
 * on any install migrated through 036. The Postgres path in 036 alters the
 * table in place and keeps its indexes, so it is unaffected; `ifNotExists`
 * makes this a no-op there.
 *
 * Forward-only: 036 has already shipped, so existing installs only recover the
 * index here. Fresh installs also get it in 036's rebuild for parity with the
 * other rebuilt tables, making this a no-op for them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createIndex("idx_taxonomies_parent")
		.ifNotExists()
		.on("taxonomies")
		.column("parent_id")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("idx_taxonomies_parent").ifExists().execute();
}
