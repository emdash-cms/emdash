import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { executeCollectionDeletionGuard } from "../../../cloudflare/src/db/d1.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { activateMediaUsageCapture } from "../../src/media/usage/activation.js";
import { SchemaRegistry } from "../../src/schema/registry.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

vi.mock("virtual:emdash/dialect", () => ({
	executeCollectionDeletionGuard: (
		_config: unknown,
		input: Parameters<typeof executeCollectionDeletionGuard>[1],
	) => executeCollectionDeletionGuard({ binding: "DB" }, input),
}));

let db: Kysely<Database>;

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await runMigrations(db);
	await activateMediaUsageCapture(db, { writersDrained: true });
});

afterAll(async () => {
	await db.destroy();
});

it("recreates a deleted collection's slug on D1", async () => {
	const registry = new SchemaRegistry(db);
	const deleted = await registry.createCollection({ slug: "products", label: "Products" });
	await registry.deleteCollection("products");

	const recreated = await registry.createCollection({ slug: "products", label: "Products" });

	expect(recreated.id).not.toBe(deleted.id);
	expect(
		await db
			.selectFrom("_emdash_media_usage_collection_deletions")
			.select("collection_id")
			.where("collection_slug", "=", "products")
			.execute(),
	).toEqual([]);
});
