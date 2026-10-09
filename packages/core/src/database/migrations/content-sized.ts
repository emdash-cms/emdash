import { sql, type Kysely } from "kysely";

import { isMissingTableError } from "../../utils/db-errors.js";
import type { Database } from "../types.js";
import { validateIdentifier } from "../validate.js";

/**
 * A migration whose work grows with the site's content. A caller that cannot
 * finish a long run, such as auto mode inside a Worker request, compares the
 * row count with its limit before it takes the migration lock.
 */
export interface ContentSizedMigration {
	/** Counts the rows the migration processes, stopping once `cap` rows are counted. */
	countRows(db: Kysely<Database>, cap: number): Promise<number>;
}

async function countTableRows(db: Kysely<Database>, table: string, cap: number): Promise<number> {
	try {
		const result = await sql<{ count: number | string | bigint }>`
			SELECT COUNT(*) AS count FROM (SELECT 1 FROM ${sql.ref(table)} LIMIT ${cap}) AS capped
		`.execute(db);
		return Number(result.rows[0]?.count ?? 0);
	} catch (error) {
		if (isMissingTableError(error)) return 0;
		throw error;
	}
}

async function countContentAndRevisionRows(db: Kysely<Database>, cap: number): Promise<number> {
	let slugs: string[];
	try {
		const collections = await db.selectFrom("_emdash_collections").select("slug").execute();
		slugs = collections.map((collection) => collection.slug);
	} catch (error) {
		if (isMissingTableError(error)) return 0;
		throw error;
	}
	let rows = await countTableRows(db, "revisions", cap);
	for (const slug of slugs) {
		if (rows >= cap) break;
		validateIdentifier(slug, "collection slug");
		// oxlint-disable-next-line no-await-in-loop -- each count is capped by what the previous ones left
		rows += await countTableRows(db, `ec_${slug}`, cap - rows);
	}
	return rows;
}

/**
 * Registered by migration name. Published migrations are immutable, so an
 * existing migration is marked here instead of in its own module.
 */
export const CONTENT_SIZED_MIGRATIONS: ReadonlyMap<string, ContentSizedMigration> = new Map([
	["079_datetime_normalization", { countRows: countContentAndRevisionRows }],
]);
