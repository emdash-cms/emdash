import type { Kysely } from "kysely";
import { sql } from "kysely";

import { currentTimestamp, detectDialect, listTablesLike } from "../dialect-helpers.js";

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

	await db.schema
		.createTable("_emdash_bylines")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("slug", "text", (col) => col.notNull().unique())
		.addColumn("display_name", "text", (col) => col.notNull())
		.addColumn("bio", "text")
		.addColumn("avatar_media_id", "text", (col) => col.references("media.id").onDelete("set null"))
		.addColumn("website_url", "text")
		.addColumn("user_id", "text", (col) => col.references("users.id").onDelete("set null"))
		.addColumn("is_guest", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.execute();

	await sql`
		CREATE UNIQUE INDEX ${sql.ref("idx_bylines_user_id_unique")}
		ON ${sql.ref("_emdash_bylines")} (user_id)
		WHERE user_id IS NOT NULL
	`.execute(db);

	await db.schema.createIndex("idx_bylines_slug").on("_emdash_bylines").column("slug").execute();

	await db.schema
		.createIndex("idx_bylines_display_name")
		.on("_emdash_bylines")
		.column("display_name")
		.execute();

	await db.schema
		.createTable("_emdash_content_bylines")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("collection_slug", "text", (col) => col.notNull())
		.addColumn("content_id", "text", (col) => col.notNull())
		.addColumn("byline_id", "text", (col) =>
			col.notNull().references("_emdash_bylines.id").onDelete("cascade"),
		)
		.addColumn("sort_order", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("role_label", "text")
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addUniqueConstraint("content_bylines_unique", ["collection_slug", "content_id", "byline_id"])
		.execute();

	await db.schema
		.createIndex("idx_content_bylines_content")
		.on("_emdash_content_bylines")
		.columns(["collection_slug", "content_id", "sort_order"])
		.execute();

	await db.schema
		.createIndex("idx_content_bylines_byline")
		.on("_emdash_content_bylines")
		.column("byline_id")
		.execute();

	const tableNames = await listTablesLike(db, "ec_%");
	for (const tableName of tableNames) {
		await sql`
			ALTER TABLE ${sql.ref(tableName)}
			ADD COLUMN primary_byline_id TEXT
		`.execute(db);

		await sql`
			CREATE INDEX ${sql.ref(`idx_${tableName}_primary_byline`)}
			ON ${sql.ref(tableName)} (primary_byline_id)
		`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	const tableNames = await listTablesLike(db, "ec_%");
	for (const tableName of tableNames) {
		await sql`
			DROP INDEX IF EXISTS ${sql.ref(`idx_${tableName}_primary_byline`)}
		`.execute(db);

		await sql`
			ALTER TABLE ${sql.ref(tableName)}
			DROP COLUMN primary_byline_id
		`.execute(db);
	}

	await db.schema.dropTable("_emdash_content_bylines").execute();
	await db.schema.dropTable("_emdash_bylines").execute();
}
