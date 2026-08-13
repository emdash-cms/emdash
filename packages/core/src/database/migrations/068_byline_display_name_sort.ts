import { sql, type Kysely } from "kysely";

import { sortKey } from "../../utils/sort-key.js";
import { columnExists } from "../dialect-helpers.js";

/**
 * Add `_emdash_bylines.display_name_sort` and fill it for every existing row.
 *
 * Ordering on `display_name` uses the database's own collation, which on SQLite
 * is BINARY: `Adam, Zoe, alice, Álvaro`. The public byline list orders on this
 * folded key instead, and seeks its cursor on it, so an author index reads
 * alphabetically and pages the same way on either dialect.
 *
 * Only the `ALTER` is guarded, so a run that dies partway can be retried.
 */

/** Rows per `UPDATE`: three bound parameters each, inside D1's 100 ceiling. */
const ROWS_PER_UPDATE = 32;

interface BylineNameRow {
	id: string;
	display_name: string;
}

export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "_emdash_bylines", "display_name_sort"))) {
		await db.schema
			.alterTable("_emdash_bylines")
			.addColumn("display_name_sort", "text", (col) => col.notNull().defaultTo(""))
			.execute();
	}

	const { rows } = await sql<BylineNameRow>`
		SELECT id, display_name FROM _emdash_bylines
	`.execute(db);

	for (let index = 0; index < rows.length; index += ROWS_PER_UPDATE) {
		const chunk = rows.slice(index, index + ROWS_PER_UPDATE);
		const arms = sql.join(
			chunk.map((row) => sql`WHEN ${row.id} THEN ${sortKey(row.display_name)}`),
			sql` `,
		);
		const ids = sql.join(chunk.map((row) => sql`${row.id}`));
		await sql`
			UPDATE _emdash_bylines
			SET display_name_sort = CASE id ${arms} END
			WHERE id IN (${ids})
		`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "_emdash_bylines", "display_name_sort")) {
		await db.schema.alterTable("_emdash_bylines").dropColumn("display_name_sort").execute();
	}
}
