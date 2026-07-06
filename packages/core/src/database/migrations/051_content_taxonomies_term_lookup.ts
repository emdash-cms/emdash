import type { Kysely } from "kysely";

/**
 * Add composite `idx_content_taxonomies_term_lookup` on
 * `content_taxonomies(taxonomy_id, collection, entry_id)` (#1834).
 *
 * The pivot's PK is `(collection, entry_id, taxonomy_id)` — it answers "which
 * terms does this entry have?" but cannot drive "which entries have this term?".
 * The single-column `idx_content_taxonomies_term(taxonomy_id)` is the right
 * shape, but a stats-blind D1/SQLite planner won't choose it once the query also
 * constrains `collection = ?`: that index is non-covering for
 * `collection`/`entry_id`, so the cost model prefers the PK's `(collection=?)`
 * covering scan — a full scan of the collection's slice of the pivot.
 *
 * The composite seeks by `taxonomy_id` *and* covers `collection`/`entry_id`, so
 * the planner drives a taxonomy-filtered listing from the selective term
 * (few matching entries) instead of scanning the whole collection table. Its
 * leftmost prefix (`taxonomy_id`) also serves every "reverse lookup by term"
 * query, so it supersedes `idx_content_taxonomies_term`, which we drop.
 *
 * Strictly additive: no data changes, and the dropped index is fully covered by
 * the new composite's prefix. Create-before-drop keeps term lookups indexed at
 * every point; both statements are idempotent so a partial apply can retry.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createIndex("idx_content_taxonomies_term_lookup")
		.ifNotExists()
		.on("content_taxonomies")
		.columns(["taxonomy_id", "collection", "entry_id"])
		.execute();

	await db.schema.dropIndex("idx_content_taxonomies_term").ifExists().execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createIndex("idx_content_taxonomies_term")
		.ifNotExists()
		.on("content_taxonomies")
		.column("taxonomy_id")
		.execute();

	await db.schema.dropIndex("idx_content_taxonomies_term_lookup").ifExists().execute();
}
