import type { Kysely } from "kysely";
import { sql } from "kysely";

import { columnExists } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "_emdash_fields", "indexed"))) {
		await sql`ALTER TABLE _emdash_fields ADD COLUMN indexed integer NOT NULL DEFAULT 0`.execute(
			db,
		);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "_emdash_fields", "indexed")) {
		await sql`ALTER TABLE _emdash_fields DROP COLUMN indexed`.execute(db);
	}
}
