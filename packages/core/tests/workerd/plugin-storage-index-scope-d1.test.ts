import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { registerPluginStorageIndexMigrationCases } from "../utils/plugin-storage-index-migration-cases.js";
import { registerPluginStorageIndexScopeCases } from "../utils/plugin-storage-index-scope-cases.js";
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

describe("plugin storage unique-index scope migration on D1", () => {
	registerPluginStorageIndexMigrationCases(() => db);
	registerPluginStorageIndexScopeCases(() => db, { sqlite: true });
});
