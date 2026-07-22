import { sql, type Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

const FIELD_ID_PATTERN = /^[0-9A-Z]{26}$/;

/** Mark custom fields whose structured list queries are backed by a physical index. */
export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "_emdash_fields", "indexed"))) {
		await db.schema
			.alterTable("_emdash_fields")
			.addColumn("indexed", "integer", (column) => column.notNull().defaultTo(0))
			.execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "_emdash_fields", "indexed"))) {
		return;
	}

	const indexedFields = await sql<{ id: string }>`
		SELECT id FROM _emdash_fields WHERE indexed = 1
	`.execute(db);

	for (const field of indexedFields.rows) {
		if (!FIELD_ID_PATTERN.test(field.id)) {
			throw new Error(`Invalid indexed field id "${field.id}"`);
		}
		await sql`
			DROP INDEX IF EXISTS ${sql.ref(`idx_cf_${field.id.toLowerCase()}`)}
		`.execute(db);
	}

	await db.schema.alterTable("_emdash_fields").dropColumn("indexed").execute();
}
