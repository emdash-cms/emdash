import type { Kysely } from "kysely";

/**
 * Timestamps carry no column default: handlers write ISO 8601 strings, which a
 * `datetime('now')` default would not sort against.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_editorial_threads")
		.ifNotExists()
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("collection", "text", (col) => col.notNull())
		.addColumn("entry_id", "text", (col) => col.notNull())
		.addColumn("anchor", "text", (col) => col.notNull())
		.addColumn("anchor_state", "text", (col) => col.notNull().defaultTo("attached"))
		.addColumn("status", "text", (col) => col.notNull().defaultTo("open"))
		.addColumn("created_by", "text", (col) => col.references("users.id").onDelete("set null"))
		.addColumn("resolved_by", "text", (col) => col.references("users.id").onDelete("set null"))
		.addColumn("resolved_at", "text")
		.addColumn("created_at", "text", (col) => col.notNull())
		.addColumn("updated_at", "text", (col) => col.notNull())
		.execute();

	await db.schema
		.createIndex("idx_editorial_threads_entry")
		.ifNotExists()
		.on("_emdash_editorial_threads")
		.columns(["collection", "entry_id", "status"])
		.execute();
	await db.schema
		.createIndex("idx_editorial_threads_created_by")
		.ifNotExists()
		.on("_emdash_editorial_threads")
		.column("created_by")
		.execute();
	await db.schema
		.createIndex("idx_editorial_threads_resolved_by")
		.ifNotExists()
		.on("_emdash_editorial_threads")
		.column("resolved_by")
		.execute();

	await db.schema
		.createTable("_emdash_editorial_comments")
		.ifNotExists()
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("thread_id", "text", (col) =>
			col.notNull().references("_emdash_editorial_threads.id").onDelete("cascade"),
		)
		.addColumn("author_id", "text", (col) => col.references("users.id").onDelete("set null"))
		.addColumn("body", "text", (col) => col.notNull())
		.addColumn("created_at", "text", (col) => col.notNull())
		.addColumn("edited_at", "text")
		.addColumn("deleted_at", "text")
		.execute();

	await db.schema
		.createIndex("idx_editorial_comments_thread")
		.ifNotExists()
		.on("_emdash_editorial_comments")
		.columns(["thread_id", "created_at"])
		.execute();
	await db.schema
		.createIndex("idx_editorial_comments_author_id")
		.ifNotExists()
		.on("_emdash_editorial_comments")
		.column("author_id")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_editorial_comments").ifExists().execute();
	await db.schema.dropTable("_emdash_editorial_threads").ifExists().execute();
}
