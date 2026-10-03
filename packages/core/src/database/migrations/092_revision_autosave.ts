import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

const DUPLICATE_COLUMN_REGEX =
	/(?:duplicate column|column .* already exists|already exists.*column)/i;

export async function up(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "revisions", "is_autosave")) return;
	try {
		await db.schema
			.alterTable("revisions")
			.addColumn("is_autosave", "integer", (column) => column.notNull().defaultTo(0))
			.execute();
	} catch (error) {
		if (
			error instanceof Error &&
			DUPLICATE_COLUMN_REGEX.test(error.message) &&
			(await columnExists(db, "revisions", "is_autosave"))
		) {
			return;
		}
		throw error;
	}
}

export async function down(_db: Kysely<unknown>): Promise<void> {
	return;
}
