import { sql, type Kysely, type RawBuilder } from "kysely";

import { isPostgres } from "../../database/dialect-helpers.js";
import type { Database } from "../../database/types.js";

/**
 * A text column compared bytewise. Package ordering is by UTF-16 code unit
 * and portable ids and paths are ASCII, so bytewise order is package order.
 * SQLite compares TEXT with BINARY by default; Postgres needs `COLLATE "C"`
 * because database collations are usually linguistic.
 */
export function bytewise(db: Kysely<Database>, column: string): RawBuilder<string> {
	return isPostgres(db)
		? sql<string>`${sql.ref(column)} COLLATE "C"`
		: sql<string>`${sql.ref(column)}`;
}

/** `LIKE` pattern matching values that start with `prefix` (use with `ESCAPE '\'`). */
export function likePrefix(prefix: string): string {
	return `${prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}
