import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

/**
 * Migration: record what kind of save wrote a revision, and who edited it.
 *
 * Adds `kind` (`autosave`, `recovery`, or NULL for a kept revision) and
 * `edited_by` (a JSON array of user IDs, latest first; NULL means the author
 * alone) to `revisions`. Existing revisions keep NULL in both, so they count
 * as kept and name only their author.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "revisions", "kind"))) {
		await db.schema.alterTable("revisions").addColumn("kind", "text").execute();
	}
	if (!(await columnExists(db, "revisions", "edited_by"))) {
		await db.schema.alterTable("revisions").addColumn("edited_by", "text").execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "revisions", "edited_by")) {
		await db.schema.alterTable("revisions").dropColumn("edited_by").execute();
	}
	if (await columnExists(db, "revisions", "kind")) {
		await db.schema.alterTable("revisions").dropColumn("kind").execute();
	}
}
