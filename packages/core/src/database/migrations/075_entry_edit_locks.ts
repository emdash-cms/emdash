import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

/**
 * Timestamps here carry no column default: `datetime('now')` renders a
 * space-separated shape that would not sort against the ISO-8601 values the
 * lease predicate compares as strings.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_entry_locks")
		.ifNotExists()
		.addColumn("collection", "text", (col) => col.notNull())
		.addColumn("entry_id", "text", (col) => col.notNull())
		.addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
		.addColumn("token", "text", (col) => col.notNull())
		.addColumn("acquired_at", "text", (col) => col.notNull())
		.addColumn("expires_at", "text", (col) => col.notNull())
		.addPrimaryKeyConstraint("pk_emdash_entry_locks", ["collection", "entry_id"])
		.execute();

	await db.schema
		.createIndex("idx_emdash_entry_locks_user_id")
		.ifNotExists()
		.on("_emdash_entry_locks")
		.column("user_id")
		.execute();

	if (!(await columnExists(db, "_emdash_collections", "edit_locking"))) {
		await db.schema
			.alterTable("_emdash_collections")
			.addColumn("edit_locking", "integer", (col) => col.notNull().defaultTo(1))
			.execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "_emdash_collections", "edit_locking")) {
		await db.schema.alterTable("_emdash_collections").dropColumn("edit_locking").execute();
	}
	await db.schema.dropIndex("idx_emdash_entry_locks_user_id").ifExists().execute();
	await db.schema.dropTable("_emdash_entry_locks").ifExists().execute();
}
