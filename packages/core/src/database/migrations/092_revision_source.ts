import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

/**
 * Add `source` to revisions so autosave cleanup can preserve baseline
 * checkpoints (e.g. the initial revision created by duplication) and
 * explicit-save checkpoints while still rotating transient autosaves.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "revisions", "source")) return;

	await db.schema
		.alterTable("revisions")
		.addColumn("source", "text", (col) => col.defaultTo("manual"))
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "revisions", "source")) {
		await db.schema.alterTable("revisions").dropColumn("source").execute();
	}
}
