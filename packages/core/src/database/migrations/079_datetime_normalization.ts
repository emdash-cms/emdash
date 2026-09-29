import type { Kysely } from "kysely";

import { normalizeDatetimeStorage } from "../datetime-storage.js";
import type { Database } from "../types.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the migration runs after the typed tables exist
	await normalizeDatetimeStorage(db as Kysely<Database>);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
	// UTC normalization is intentionally irreversible because the original notation carried no extra data.
}
