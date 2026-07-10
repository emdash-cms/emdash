import type { Kysely } from "kysely";

import { currentTimestamp } from "../dialect-helpers.js";

/**
 * Taxonomy definitions migration
 *
 * Adds _emdash_taxonomy_defs table to store taxonomy definitions (category, tag, custom)
 * and seeds default category and tag taxonomies.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	// Taxonomy definitions (what taxonomies exist)
	await db.schema
		.createTable("_emdash_taxonomy_defs")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("name", "text", (col) => col.notNull().unique()) // 'category', 'tag'
		.addColumn("label", "text", (col) => col.notNull()) // 'Categories'
		.addColumn("label_singular", "text") // 'Category'
		.addColumn("hierarchical", "integer", (col) => col.defaultTo(0)) // 0 or 1
		.addColumn("collections", "text") // JSON array: ["posts"]
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.execute();

	// Seed default taxonomies
	await db
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Kysely migration runs against unknown schema
		.insertInto("_emdash_taxonomy_defs" as never)
		.values([
			{
				id: "taxdef_category",
				name: "category",
				label: "Categories",
				label_singular: "Category",
				hierarchical: 1,
				collections: JSON.stringify(["posts"]),
			},
			{
				id: "taxdef_tag",
				name: "tag",
				label: "Tags",
				label_singular: "Tag",
				hierarchical: 0,
				collections: JSON.stringify(["posts"]),
			},
		])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_taxonomy_defs").execute();
}
