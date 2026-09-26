import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { up as createBlockTypeTables } from "../../src/database/migrations/083_block_types.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { BlockTypeRegistry } from "../../src/schema/block-type-registry.js";
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

describe("BlockTypeRegistry on D1", () => {
	it("resumes when the version table is missing after a partial migration", async () => {
		await db.schema.dropTable("_emdash_block_type_versions").execute();

		await expect(createBlockTypeTables(db)).resolves.toBeUndefined();
		await expect(
			db.selectFrom("_emdash_block_type_versions").select("id").execute(),
		).resolves.toEqual([]);
	});

	it("creates the type and initial version atomically", async () => {
		const registry = new BlockTypeRegistry(db);
		const created = await registry.createBlockType({
			slug: "hero",
			label: "Hero",
			fields: [{ slug: "heading", label: "Heading", type: "string", required: true }],
		});

		expect(created.currentVersion).toBe(1);
		expect(created.versions).toHaveLength(1);
		expect(await db.selectFrom("_emdash_block_types").select("id").execute()).toHaveLength(1);
		expect(await db.selectFrom("_emdash_block_type_versions").select("id").execute()).toHaveLength(
			1,
		);
	});

	it("uses one atomic batch for a compatible contract and metadata update", async () => {
		const registry = new BlockTypeRegistry(db);
		const created = await registry.createBlockType({
			slug: "hero",
			label: "Hero",
			fields: [{ slug: "heading", label: "Heading", type: "string" }],
		});

		const updated = await registry.updateBlockType("hero", {
			expectedFingerprint: created.versions[0]!.fingerprint,
			label: "Page hero",
			fields: [
				{ slug: "heading", label: "Heading", type: "string" },
				{ slug: "eyebrow", label: "Eyebrow", type: "string" },
			],
		});

		expect(updated.label).toBe("Page hero");
		expect(updated.versions).toHaveLength(1);
		expect(updated.versions[0]?.fields.map((field) => field.slug)).toEqual(["heading", "eyebrow"]);
	});
});
