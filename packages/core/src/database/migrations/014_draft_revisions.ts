import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// Get all content tables
	const tables = await db
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Kysely migration runs against unknown schema
		.selectFrom("_emdash_collections" as never)
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Kysely migration runs against unknown schema
		.select("slug" as never)
		.execute();

	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Kysely execute returns unknown[]; narrowing to known shape
	for (const row of tables as Array<{ slug: string }>) {
		const tableName = `ec_${row.slug}`;

		// Add live_revision_id column
		await sql`
			ALTER TABLE ${sql.ref(tableName)}
			ADD COLUMN live_revision_id TEXT REFERENCES revisions(id)
		`.execute(db);

		// Add draft_revision_id column
		await sql`
			ALTER TABLE ${sql.ref(tableName)}
			ADD COLUMN draft_revision_id TEXT REFERENCES revisions(id)
		`.execute(db);

		// Create indexes for the new columns
		await sql`
			CREATE INDEX ${sql.ref(`idx_${row.slug}_live_revision`)}
			ON ${sql.ref(tableName)} (live_revision_id)
		`.execute(db);

		await sql`
			CREATE INDEX ${sql.ref(`idx_${row.slug}_draft_revision`)}
			ON ${sql.ref(tableName)} (draft_revision_id)
		`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	const tables = await db
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Kysely migration runs against unknown schema
		.selectFrom("_emdash_collections" as never)
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Kysely migration runs against unknown schema
		.select("slug" as never)
		.execute();

	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Kysely execute returns unknown[]; narrowing to known shape
	for (const row of tables as Array<{ slug: string }>) {
		const tableName = `ec_${row.slug}`;

		await sql`
			DROP INDEX IF EXISTS ${sql.ref(`idx_${row.slug}_draft_revision`)}
		`.execute(db);

		await sql`
			DROP INDEX IF EXISTS ${sql.ref(`idx_${row.slug}_live_revision`)}
		`.execute(db);

		await sql`
			ALTER TABLE ${sql.ref(tableName)}
			DROP COLUMN draft_revision_id
		`.execute(db);

		await sql`
			ALTER TABLE ${sql.ref(tableName)}
			DROP COLUMN live_revision_id
		`.execute(db);
	}
}
