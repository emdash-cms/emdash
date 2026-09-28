import type { Kysely } from "kysely";

import { currentTimestamp } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_block_types")
		.ifNotExists()
		.addColumn("id", "text", (column) => column.primaryKey())
		.addColumn("slug", "text", (column) => column.notNull().unique())
		.addColumn("label", "text", (column) => column.notNull())
		.addColumn("description", "text")
		.addColumn("icon", "text")
		.addColumn("category", "text")
		.addColumn("current_version", "integer", (column) => column.notNull().defaultTo(1))
		.addColumn("source", "text", (column) => column.notNull().defaultTo("user"))
		.addColumn("created_at", "text", (column) => column.notNull().defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (column) => column.notNull().defaultTo(currentTimestamp(db)))
		.execute();

	await db.schema
		.createTable("_emdash_block_type_versions")
		.ifNotExists()
		.addColumn("id", "text", (column) => column.primaryKey())
		.addColumn("block_type_id", "text", (column) => column.notNull())
		.addColumn("version", "integer", (column) => column.notNull())
		.addColumn("fields", "text", (column) => column.notNull())
		.addColumn("fingerprint", "text", (column) => column.notNull())
		.addColumn("created_at", "text", (column) => column.notNull().defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (column) => column.notNull().defaultTo(currentTimestamp(db)))
		.addForeignKeyConstraint(
			"block_type_versions_type_fk",
			["block_type_id"],
			"_emdash_block_types",
			["id"],
			(constraint) => constraint.onDelete("cascade"),
		)
		.execute();

	await db.schema
		.createIndex("idx_block_type_versions_type_version")
		.ifNotExists()
		.on("_emdash_block_type_versions")
		.columns(["block_type_id", "version"])
		.unique()
		.execute();
	await db.schema
		.createIndex("idx_block_type_versions_type")
		.ifNotExists()
		.on("_emdash_block_type_versions")
		.column("block_type_id")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_block_type_versions").ifExists().execute();
	await db.schema.dropTable("_emdash_block_types").ifExists().execute();
}
