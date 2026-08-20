import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

/**
 * Multi-tenant scoping.
 *
 * Adds `tenant_id` to the system tables that repository queries filter by
 * tenant (see `getTenantId()` in `request-context.ts`), plus supporting
 * indexes. Single-tenant deployments are unaffected: every row defaults to
 * `'default'`, matching `getTenantId()`'s fallback outside a request
 * context.
 */
const TABLES = [
	"revisions",
	"taxonomies",
	"content_taxonomies",
	"media",
	"audit_logs",
	"_emdash_collections",
	"_emdash_fields",
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
	for (const table of TABLES) {
		if (!(await columnExists(db, table, "tenant_id"))) {
			await db.schema
				.alterTable(table)
				.addColumn("tenant_id", "text", (col) => col.notNull().defaultTo("default"))
				.execute();
		}
	}

	for (const table of TABLES) {
		await db.schema
			.createIndex(`idx_${table.replace(/^_/, "")}_tenant_id`)
			.ifNotExists()
			.on(table)
			.column("tenant_id")
			.execute();
	}

	await db.schema
		.createIndex("idx_taxonomies_tenant_id_name")
		.ifNotExists()
		.on("taxonomies")
		.columns(["tenant_id", "name"])
		.execute();

	await db.schema
		.createIndex("idx_media_tenant_id_created_at")
		.ifNotExists()
		.on("media")
		.columns(["tenant_id", "created_at"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("idx_media_tenant_id_created_at").ifExists().execute();
	await db.schema.dropIndex("idx_taxonomies_tenant_id_name").ifExists().execute();

	for (const table of TABLES) {
		await db.schema
			.dropIndex(`idx_${table.replace(/^_/, "")}_tenant_id`)
			.ifExists()
			.execute();
	}

	for (const table of TABLES) {
		if (await columnExists(db, table, "tenant_id")) {
			await db.schema.alterTable(table).dropColumn("tenant_id").execute();
		}
	}
}
