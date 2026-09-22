import type { Kysely } from "kysely";

/**
 * Restore `idx_content_taxonomies_term` on `content_taxonomies(taxonomy_id)` (#1701).
 *
 * Migration 015 created this index. 036's SQLite/D1 table rebuild recreated it,
 * but the recreate was gated behind an FK-presence early-return: if a first run
 * committed the rebuild (stripping the FK and dropping the old index) and then
 * failed before the recreate, the retry saw zero FKs, skipped the whole body,
 * and never restored the index — while 036 was still recorded as applied. The
 * result was an install missing only this one index, with no forward migration
 * to recover it (the sibling `idx_taxonomies_parent` case was fixed by 047).
 *
 * 036 has since been fixed to recreate the index unconditionally, so fresh
 * installs are fine. This recovers the index on installs that hit the trap
 * before that fix. The Postgres path in 036 alters in place and keeps its
 * indexes, so it is unaffected; `ifNotExists` makes this a no-op there.
 *
 * Forward-only.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createIndex("idx_content_taxonomies_term")
		.ifNotExists()
		.on("content_taxonomies")
		.column("taxonomy_id")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("idx_content_taxonomies_term").ifExists().execute();
}
