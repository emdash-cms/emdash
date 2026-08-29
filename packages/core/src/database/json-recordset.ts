import { sql, type Kysely, type RawBuilder } from "kysely";

import { isPostgres } from "./dialect-helpers.js";
import type { Database } from "./types.js";

export function jsonTextValues(
	db: Kysely<Database>,
	values: readonly string[],
): RawBuilder<{ value: string }> {
	const payload = JSON.stringify([...new Set(values)]);
	return isPostgres(db)
		? sql<{
				value: string;
			}>`SELECT value::text AS value FROM jsonb_array_elements_text(${payload}::jsonb) AS value`
		: sql<{ value: string }>`SELECT value AS value FROM json_each(${payload})`;
}
