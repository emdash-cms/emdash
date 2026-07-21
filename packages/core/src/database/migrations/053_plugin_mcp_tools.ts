import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

/** Persist explicit per-plugin MCP enablement and the declaration consented to by an admin. */
export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "_plugin_state", "mcp_tools_enabled"))) {
		await db.schema
			.alterTable("_plugin_state")
			.addColumn("mcp_tools_enabled", "integer", (col) => col.notNull().defaultTo(0))
			.execute();
	}
	if (!(await columnExists(db, "_plugin_state", "mcp_tools_consent"))) {
		await db.schema.alterTable("_plugin_state").addColumn("mcp_tools_consent", "text").execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("_plugin_state").dropColumn("mcp_tools_consent").execute();
	await db.schema.alterTable("_plugin_state").dropColumn("mcp_tools_enabled").execute();
}
