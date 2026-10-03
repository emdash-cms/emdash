import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { verifyRevisionAutosaveUpgrade } from "../utils/revision-autosave-migration-cases.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;

beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
});

beforeEach(async () => {
	await resetD1Schema(db);
	await runMigrations(db);
});

afterAll(async () => {
	await db.destroy();
});

it("preserves old checkpoints and autosave behavior after D1 migration retries", async () => {
	await verifyRevisionAutosaveUpgrade(db);
});
