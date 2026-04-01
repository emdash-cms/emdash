import type { Kysely } from "kysely";

import { currentTimestamp } from "../dialect-helpers.js";

/**
 * Initial schema migration
 *
 * Note: Content tables (ec_posts, ec_pages, etc.) are created dynamically
 * by the SchemaRegistry when collections are added via the admin UI.
 * This migration only creates system tables.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	// Revisions - stores snapshots of content entries
	// References entries in ec_* tables by collection + entry_id
	await db.schema
		.createTable("revisions")
		.ifNotExists()
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("collection", "text", (col) => col.notNull()) // e.g., 'posts'
		.addColumn("entry_id", "text", (col) => col.notNull()) // ID in the ec_* table
		.addColumn("data", "text", (col) => col.notNull()) // JSON snapshot of all fields
		.addColumn("author_id", "text")
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.execute();

	await db.schema
		.createIndex("idx_revisions_entry")
		.ifNotExists()
		.on("revisions")
		.columns(["collection", "entry_id"])
		.execute();

	// Taxonomies
	await db.schema
		.createTable("taxonomies")
		.ifNotExists()
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("name", "text", (col) => col.notNull())
		.addColumn("slug", "text", (col) => col.notNull())
		.addColumn("label", "text", (col) => col.notNull())
		.addColumn("parent_id", "text")
		.addColumn("data", "text")
		.addUniqueConstraint("taxonomies_name_slug_unique", ["name", "slug"])
		.addForeignKeyConstraint("taxonomies_parent_fk", ["parent_id"], "taxonomies", ["id"], (cb) =>
			cb.onDelete("set null"),
		)
		.execute();

	await db.schema
		.createIndex("idx_taxonomies_name")
		.ifNotExists()
		.on("taxonomies")
		.column("name")
		.execute();

	// Content-Taxonomy junction - references entries in ec_* tables
	await db.schema
		.createTable("content_taxonomies")
		.ifNotExists()
		.addColumn("collection", "text", (col) => col.notNull()) // e.g., 'posts'
		.addColumn("entry_id", "text", (col) => col.notNull()) // ID in the ec_* table
		.addColumn("taxonomy_id", "text", (col) => col.notNull())
		.addPrimaryKeyConstraint("content_taxonomies_pk", ["collection", "entry_id", "taxonomy_id"])
		.addForeignKeyConstraint(
			"content_taxonomies_taxonomy_fk",
			["taxonomy_id"],
			"taxonomies",
			["id"],
			(cb) => cb.onDelete("cascade"),
		)
		.execute();

	// Media
	await db.schema
		.createTable("media")
		.ifNotExists()
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("filename", "text", (col) => col.notNull())
		.addColumn("mime_type", "text", (col) => col.notNull())
		.addColumn("size", "integer")
		.addColumn("width", "integer")
		.addColumn("height", "integer")
		.addColumn("alt", "text")
		.addColumn("caption", "text")
		.addColumn("storage_key", "text", (col) => col.notNull())
		.addColumn("content_hash", "text") // xxHash64 for deduplication
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addColumn("author_id", "text")
		.execute();

	await db.schema
		.createIndex("idx_media_content_hash")
		.ifNotExists()
		.on("media")
		.column("content_hash")
		.execute();

	// Users
	await db.schema
		.createTable("users")
		.ifNotExists()
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("email", "text", (col) => col.notNull().unique())
		.addColumn("password_hash", "text", (col) => col.notNull())
		.addColumn("name", "text")
		.addColumn("role", "text", (col) => col.defaultTo("subscriber"))
		.addColumn("avatar_id", "text")
		.addColumn("data", "text")
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.execute();

	await db.schema
		.createIndex("idx_users_email")
		.ifNotExists()
		.on("users")
		.column("email")
		.execute();

	// Options (key-value store)
	await db.schema
		.createTable("options")
		.ifNotExists()
		.addColumn("name", "text", (col) => col.primaryKey())
		.addColumn("value", "text", (col) => col.notNull())
		.execute();

	// Audit logs (security events)
	await db.schema
		.createTable("audit_logs")
		.ifNotExists()
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("timestamp", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addColumn("actor_id", "text")
		.addColumn("actor_ip", "text")
		.addColumn("action", "text", (col) => col.notNull())
		.addColumn("resource_type", "text")
		.addColumn("resource_id", "text")
		.addColumn("details", "text")
		.addColumn("status", "text")
		.execute();

	await db.schema
		.createIndex("idx_audit_actor")
		.ifNotExists()
		.on("audit_logs")
		.column("actor_id")
		.execute();
	await db.schema
		.createIndex("idx_audit_action")
		.ifNotExists()
		.on("audit_logs")
		.column("action")
		.execute();
	await db.schema
		.createIndex("idx_audit_timestamp")
		.ifNotExists()
		.on("audit_logs")
		.column("timestamp")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("audit_logs").execute();
	await db.schema.dropTable("options").execute();
	await db.schema.dropTable("users").execute();
	await db.schema.dropTable("media").execute();
	await db.schema.dropTable("content_taxonomies").execute();
	await db.schema.dropTable("taxonomies").execute();
	await db.schema.dropTable("revisions").execute();
}
