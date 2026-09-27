import type { Kysely } from "kysely";

import { OptionsRepository } from "../database/repositories/options.js";
import type { Database } from "../database/types.js";
import type { SeedFile } from "./types.js";

export const AUTO_SEED_COMPLETE_OPTION = "emdash:seed_complete";

export async function claimExplicitSeedOwnership(
	db: Kysely<Database>,
	seed: SeedFile,
): Promise<void> {
	if (!seed.collections?.length) return;
	await new OptionsRepository(db).set(AUTO_SEED_COMPLETE_OPTION, true);
}
