import type { Kysely } from "kysely";

import { isSqlite } from "../database/dialect-helpers.js";
import type { Database } from "../database/types.js";
import { apiError } from "./error.js";

export function requireSearchSupport(db: Kysely<Database>): Response | null {
	if (isSqlite(db)) return null;
	return apiError(
		"SEARCH_UNAVAILABLE",
		"Built-in search is unavailable on PostgreSQL, including Hyperdrive. " +
			"Search requires SQLite, D1, or libSQL with FTS5 support.",
		503,
	);
}
