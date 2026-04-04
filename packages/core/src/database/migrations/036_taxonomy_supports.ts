import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE _emdash_taxonomy_defs ADD COLUMN supports TEXT`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE _emdash_taxonomy_defs DROP COLUMN supports`.execute(db);
}
