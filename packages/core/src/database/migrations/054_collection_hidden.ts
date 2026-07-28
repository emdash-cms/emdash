import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

/**
 * Migration: hide a collection from the admin sidebar.
 *
 * Adds `hidden` to `_emdash_collections`. A hidden collection stays fully
 * functional (REST API, MCP, plugin hooks, direct `/content/:collection`
 * URLs) — only its auto-generated sidebar entry is omitted, so plugins that
 * own a collection end to end can steer editors to their own admin UI.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "_emdash_collections", "hidden"))) {
		await db.schema
			.alterTable("_emdash_collections")
			.addColumn("hidden", "integer", (col) => col.notNull().defaultTo(0))
			.execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("_emdash_collections").dropColumn("hidden").execute();
}
