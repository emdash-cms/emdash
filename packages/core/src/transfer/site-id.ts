import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import { OptionsRepository } from "../database/repositories/options.js";
import type { Database } from "../database/types.js";

/**
 * Option holding this installation's site id. Target-local: never exported
 * and never overwritten by an import.
 */
export const SITE_ID_OPTION = "emdash:site_id";

/**
 * This installation's site id, created on first use. Concurrent first callers
 * converge on one value: creation is an insert-if-absent, and a caller that
 * loses the race reads the winner's value.
 */
export async function getOrCreateSiteId(db: Kysely<Database>): Promise<string> {
	const options = new OptionsRepository(db);
	const existing = await options.get(SITE_ID_OPTION);
	if (typeof existing === "string" && existing.length > 0) return existing;

	const candidate = ulid();
	const result = await options.compareAndSet(SITE_ID_OPTION, null, candidate);
	if (result.applied) return candidate;

	const winner = await options.get(SITE_ID_OPTION);
	if (typeof winner === "string" && winner.length > 0) return winner;
	throw new Error("Site id option exists but is not a non-empty string");
}
