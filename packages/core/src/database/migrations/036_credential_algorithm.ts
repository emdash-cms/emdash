import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	const tableInfo = await sql<{ name: string }>`PRAGMA table_info(credentials)`.execute(db);
	const columnExists = tableInfo.rows.some((col) => col.name === "algorithm");

	if (!columnExists) {
		await db.schema
			.alterTable("credentials")
			.addColumn("algorithm", "integer", (col) => col.notNull().defaultTo(-7))
			.execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("credentials").dropColumn("algorithm").execute();
}
