import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import type { Database } from "../../src/database/types.js";
import {
	createLegacyPluginStorageTables,
	pluginStorageRevisionMigrationCases,
} from "../utils/plugin-storage-revision-cases.js";
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
	await createLegacyPluginStorageTables(db);
});

afterAll(async () => {
	await db.destroy();
});

describe("plugin storage revision migration on D1", () => {
	pluginStorageRevisionMigrationCases(() => db, true);
});
