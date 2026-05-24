import { type Kysely, sql } from "kysely";

/**
 * Migration: Add sections tables and performance indexes
 *
 * Sections are reusable content blocks that can be inserted into any Portable Text field.
 * They provide a library of pre-built page sections (heroes, CTAs, testimonials, etc.)
 * that content authors can browse and insert with a single click.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	// Section categories table
	await db.schema
		.createTable("_emdash_section_categories")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("slug", "text", (col) => col.notNull().unique())
		.addColumn("label", "text", (col) => col.notNull())
		.addColumn("sort_order", "integer", (col) => col.defaultTo(0))
		.addColumn("created_at", "text", (col) => col.defaultTo(sql`CURRENT_TIMESTAMP`))
		.execute();

	// Sections table
	await db.schema
		.createTable("_emdash_sections")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("slug", "text", (col) => col.notNull().unique())
		.addColumn("title", "text", (col) => col.notNull())
		.addColumn("description", "text")
		// Categorization
		.addColumn("category_id", "text", (col) =>
			col.references("_emdash_section_categories.id").onDelete("set null"),
		)
		.addColumn("keywords", "text") // JSON array for search
		// Content (Portable Text array)
		.addColumn("content", "text", (col) => col.notNull()) // JSON
		// Preview image (optional)
		.addColumn("preview_media_id", "text")
		// Source tracking
		.addColumn("source", "text", (col) => col.notNull().defaultTo("user")) // 'theme', 'user', 'import'
		.addColumn("theme_id", "text") // Which theme provided it (if source='theme')
		// Metadata
		.addColumn("created_at", "text", (col) => col.defaultTo(sql`CURRENT_TIMESTAMP`))
		.addColumn("updated_at", "text", (col) => col.defaultTo(sql`CURRENT_TIMESTAMP`))
		.execute();

	// Index for efficient category lookups
	await db.schema
		.createIndex("idx_sections_category")
		.on("_emdash_sections")
		.columns(["category_id"])
		.execute();

	// Index for filtering by source
	await db.schema
		.createIndex("idx_sections_source")
		.on("_emdash_sections")
		.columns(["source"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("idx_sections_source").execute();
	await db.schema.dropIndex("idx_sections_category").execute();
	await db.schema.dropTable("_emdash_sections").execute();
	await db.schema.dropTable("_emdash_section_categories").execute();
}
