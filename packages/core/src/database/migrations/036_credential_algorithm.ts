import { type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("credentials")
		.addColumn("algorithm", "integer", (col) => col.notNull().defaultTo(-7))
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("credentials").dropColumn("algorithm").execute();
}
