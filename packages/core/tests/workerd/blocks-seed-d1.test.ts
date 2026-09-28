import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { BlockTypeRegistry } from "../../src/schema/block-type-registry.js";
import { applySeed } from "../../src/seed/apply.js";
import type { SeedFile } from "../../src/seed/types.js";
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

describe("blocks seed on D1", () => {
	it("applies exact retained versions and active pointer idempotently", async () => {
		const seed: SeedFile = {
			version: "1",
			blockTypes: [
				{
					slug: "hero",
					label: "Hero",
					currentVersion: 2,
					versions: [
						{
							version: 1,
							fields: [{ slug: "heading", label: "Heading", type: "string" }],
						},
						{
							version: 2,
							fields: [{ slug: "title", label: "Title", type: "string" }],
						},
					],
				},
			],
		};

		await applySeed(db, seed);
		await applySeed(db, seed, { onConflict: "update" });

		const type = await new BlockTypeRegistry(db).getBlockType("hero");
		expect(type?.currentVersion).toBe(2);
		expect(type?.versions.map((version) => version.version)).toEqual([1, 2]);
	});
});
