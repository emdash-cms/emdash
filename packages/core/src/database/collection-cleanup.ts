import type { Kysely } from "kysely";

import type { Database } from "./types.js";

/**
 * Delete records in shared tables that belong to a given collection's entries.
 *
 * These tables are keyed by collection slug rather than by a foreign key to the
 * content table, so dropping `ec_<slug>` or deleting the collection row does not
 * remove them. The caller must run this before the collection identity
 * disappears, otherwise the rows become orphans that nothing else sweeps.
 */
export async function deleteSharedCollectionRecords(
	db: Kysely<Database>,
	collectionSlug: string,
): Promise<void> {
	await db.deleteFrom("revisions").where("collection", "=", collectionSlug).execute();
	await db
		.deleteFrom("_emdash_revision_prune_queue")
		.where("collection", "=", collectionSlug)
		.execute();
	await db.deleteFrom("_emdash_seo").where("collection", "=", collectionSlug).execute();
	await db.deleteFrom("_emdash_comments").where("collection", "=", collectionSlug).execute();
	await db
		.deleteFrom("_emdash_content_bylines")
		.where("collection_slug", "=", collectionSlug)
		.execute();
	await db.deleteFrom("content_taxonomies").where("collection", "=", collectionSlug).execute();
	await db.deleteFrom("_emdash_entry_locks").where("collection", "=", collectionSlug).execute();
}
