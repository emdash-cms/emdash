import type { Kysely } from "kysely";
import { sql } from "kysely";

import { currentTimestamp, detectDialect } from "../dialect-helpers.js";

async function getForeignKeyColumnType(db: Kysely<unknown>, referencedTable: string, referencedColumn: string): Promise<string> {
    try {
        const result = await sql<{ data_type: string }>`
            SELECT data_type
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = ${referencedTable} AND column_name = ${referencedColumn}
        `.execute(db);
        const colType = result.rows[0]?.data_type ?? null;
        if (colType === "uuid") return "uuid";
        return "text";
    } catch {
        return "text";
    }
}

export async function up(db: Kysely<unknown>): Promise<void> {
	const dialect = detectDialect(db);
	const userIdType = dialect === "postgres" ? await getForeignKeyColumnType(db, "users", "id") : "text";

	// Create the comments table
	await db.schema
		.createTable("_emdash_comments")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("collection", "text", (col) => col.notNull())
		.addColumn("content_id", "text", (col) => col.notNull())
		.addColumn("parent_id", "text", (col) =>
			col.references("_emdash_comments.id").onDelete("cascade"),
		)
		.addColumn("author_name", "text", (col) => col.notNull())
		.addColumn("author_email", "text", (col) => col.notNull())
		.addColumn("author_url", "text")
		.addColumn("author_user_id", "text", (col) => col.references("users.id").onDelete("set null"))
		.addColumn("body", "text", (col) => col.notNull())
		.addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
		.addColumn("ip_hash", "text")
		.addColumn("user_agent", "text")
		.addColumn("moderation_metadata", "text") // JSON
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.execute();

	// Indexes
	await db.schema
		.createIndex("idx_comments_content")
		.on("_emdash_comments")
		.columns(["collection", "content_id", "status"])
		.execute();

	await db.schema
		.createIndex("idx_comments_parent")
		.on("_emdash_comments")
		.column("parent_id")
		.execute();

	await db.schema
		.createIndex("idx_comments_status")
		.on("_emdash_comments")
		.columns(["status", "created_at"])
		.execute();

	await db.schema
		.createIndex("idx_comments_author_email")
		.on("_emdash_comments")
		.column("author_email")
		.execute();

	await db.schema
		.createIndex("idx_comments_author_user")
		.on("_emdash_comments")
		.column("author_user_id")
		.execute();

	// Add collection-level comment settings columns
	await db.schema
		.alterTable("_emdash_collections")
		.addColumn("comments_enabled", "integer", (col) => col.defaultTo(0))
		.execute();

	await db.schema
		.alterTable("_emdash_collections")
		.addColumn("comments_moderation", "text", (col) => col.defaultTo("first_time"))
		.execute();

	await db.schema
		.alterTable("_emdash_collections")
		.addColumn("comments_closed_after_days", "integer", (col) => col.defaultTo(90))
		.execute();

	await db.schema
		.alterTable("_emdash_collections")
		.addColumn("comments_auto_approve_users", "integer", (col) => col.defaultTo(1))
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_comments").execute();

	// Note: SQLite doesn't support DROP COLUMN before 3.35.0.
	// For down migrations on the collection settings columns, the table
	// would need to be rebuilt. Skipping for simplicity in v0.
}
