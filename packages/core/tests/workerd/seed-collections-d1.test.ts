import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { activateMediaUsageCapture } from "../../src/media/usage/activation.js";
import {
	buildSeedCollectionCaptureFingerprint,
	SchemaRegistry,
} from "../../src/schema/registry.js";
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

describe("interrupted collection seed on D1", () => {
	it("recovers the orphaned table and preserves its collection id", async () => {
		await activateMediaUsageCapture(db, { writersDrained: true });
		const seed: SeedFile = {
			version: "1",
			collections: [
				{
					slug: "routes",
					label: "Routes",
					supports: [],
					fields: [{ slug: "title", label: "Title", type: "string" }],
				},
			],
		};
		await applySeed(db, seed);
		const registry = new SchemaRegistry(db);
		const original = await registry.getCollection("routes");
		if (!original) throw new Error("Expected seeded collection");
		await db.deleteFrom("_emdash_fields").where("collection_id", "=", original.id).execute();
		await db.deleteFrom("_emdash_collections").where("id", "=", original.id).execute();
		const fingerprint = await buildSeedCollectionCaptureFingerprint(
			{ slug: "routes", label: "Routes", supports: [] },
			[{ slug: "title", label: "Title", type: "string" }],
		);
		await db
			.updateTable("_emdash_media_usage_index_status")
			.set({ capture_state: "installing", cursor: fingerprint })
			.where("collection_id", "=", original.id)
			.execute();

		await applySeed(db, seed);
		const recovered = await registry.getCollectionWithFields("routes");
		expect(recovered?.id).toBe(original.id);
		expect(recovered?.fields.map((field) => field.slug)).toEqual(["title"]);
		expect(
			await db
				.selectFrom("_emdash_media_usage_index_status")
				.select("capture_state")
				.where("collection_id", "=", original.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ capture_state: "active" });
	});
});
