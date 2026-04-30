/**
 * Regression test for #776: applying a seed must invalidate the persisted
 * `emdash:manifest_cache` row in the `options` table whenever the seed
 * creates or updates collections, fields, or taxonomy definitions.
 *
 * Without this, a stale manifest survives the seed -- so a field defined
 * with `type: "json"` in seed continues to render in the admin with the
 * `kind` it had in the previous manifest build (e.g. `richText`, which
 * shows the markdown textarea instead of the JSON editor).
 *
 * The reproduction here mirrors the scenario in the bug report:
 *   1. Build a manifest while the field is `text` -> persisted row carries
 *      `kind: "richText"` for that field.
 *   2. Update the field to `type: "json"` via the seed pipeline.
 *   3. The persisted manifest cache must be cleared so the next reader
 *      rebuilds it and reports `kind: "json"`.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OptionsRepository } from "../../src/database/repositories/options.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { applySeed } from "../../src/seed/apply.js";
import type { SeedFile } from "../../src/seed/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";

const MANIFEST_CACHE_KEY = "emdash:manifest_cache";

/** Seed an existing collection + field directly so we control the prior state. */
async function seedExistingPagesWithBody(db: Kysely<Database>, type: "text" | "json") {
	const registry = new SchemaRegistry(db);
	await registry.createCollection({
		slug: "pages",
		label: "Pages",
		labelSingular: "Page",
		source: "seed",
	});
	await registry.createField("pages", {
		slug: "title",
		label: "Title",
		type: "string",
		required: true,
	});
	await registry.createField("pages", {
		slug: "body",
		label: "Body",
		type,
	});
}

describe("applySeed manifest cache invalidation (regression for #776)", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("clears the persisted manifest cache when the seed creates a new collection", async () => {
		const options = new OptionsRepository(db);
		// Simulate a previously-built manifest sitting in the options table.
		await options.set(MANIFEST_CACHE_KEY, {
			key: "stale-key",
			manifest: { stale: true },
		});

		const seed: SeedFile = {
			version: "1",
			collections: [
				{
					slug: "pages",
					label: "Pages",
					labelSingular: "Page",
					fields: [
						{ slug: "title", label: "Title", type: "string", required: true },
						{ slug: "body", label: "Body", type: "json" },
					],
				},
			],
		};

		await applySeed(db, seed);

		const cached = await options.get(MANIFEST_CACHE_KEY);
		expect(cached).toBeNull();
	});

	it("clears the persisted manifest cache when the seed updates an existing field", async () => {
		await seedExistingPagesWithBody(db, "text");

		const options = new OptionsRepository(db);
		await options.set(MANIFEST_CACHE_KEY, {
			key: "stale-key",
			manifest: {
				collections: {
					pages: {
						fields: { body: { kind: "richText", label: "Body" } },
					},
				},
			},
		});

		const seed: SeedFile = {
			version: "1",
			collections: [
				{
					slug: "pages",
					label: "Pages",
					labelSingular: "Page",
					fields: [
						{ slug: "title", label: "Title", type: "string", required: true },
						{ slug: "body", label: "Body", type: "json" },
					],
				},
			],
		};

		await applySeed(db, seed, { onConflict: "update" });

		const cached = await options.get(MANIFEST_CACHE_KEY);
		expect(cached).toBeNull();
	});

	it("clears the persisted manifest cache when the seed updates an existing taxonomy definition", async () => {
		// Seed once to create the taxonomy definition.
		const initial: SeedFile = {
			version: "1",
			collections: [
				{
					slug: "posts",
					label: "Posts",
					fields: [{ slug: "title", label: "Title", type: "string" }],
				},
			],
			taxonomies: [
				{
					name: "topics",
					label: "Topics",
					hierarchical: false,
					collections: ["posts"],
				},
			],
		};
		await applySeed(db, initial);

		// Pretend the manifest got cached.
		const options = new OptionsRepository(db);
		await options.set(MANIFEST_CACHE_KEY, {
			key: "stale-key",
			manifest: { taxonomies: [{ name: "topics", label: "Topics" }] },
		});

		// Re-seed with a new label for the existing taxonomy.
		const updated: SeedFile = {
			version: "1",
			taxonomies: [
				{
					name: "topics",
					label: "Subjects",
					hierarchical: false,
					collections: ["posts"],
				},
			],
		};
		await applySeed(db, updated, { onConflict: "update" });

		// Cache must be cleared even though no SeedApplyResult counter
		// reflects taxonomy-definition updates.
		const cached = await options.get(MANIFEST_CACHE_KEY);
		expect(cached).toBeNull();
	});

	it("clears the persisted manifest cache when the seed creates a taxonomy definition", async () => {
		const options = new OptionsRepository(db);
		await options.set(MANIFEST_CACHE_KEY, {
			key: "stale-key",
			manifest: { taxonomies: [] },
		});

		const seed: SeedFile = {
			version: "1",
			collections: [
				{
					slug: "posts",
					label: "Posts",
					fields: [{ slug: "title", label: "Title", type: "string" }],
				},
			],
			taxonomies: [
				{
					name: "topics",
					label: "Topics",
					hierarchical: false,
					collections: ["posts"],
				},
			],
		};

		await applySeed(db, seed);

		const cached = await options.get(MANIFEST_CACHE_KEY);
		expect(cached).toBeNull();
	});

	it("does not touch an unrelated options row", async () => {
		const options = new OptionsRepository(db);
		await options.set("emdash:setup_complete", true);
		await options.set(MANIFEST_CACHE_KEY, {
			key: "stale-key",
			manifest: {},
		});

		const seed: SeedFile = {
			version: "1",
			collections: [
				{
					slug: "posts",
					label: "Posts",
					fields: [{ slug: "title", label: "Title", type: "string" }],
				},
			],
		};

		await applySeed(db, seed);

		expect(await options.get(MANIFEST_CACHE_KEY)).toBeNull();
		expect(await options.get<boolean>("emdash:setup_complete")).toBe(true);
	});

	it("leaves the persisted manifest cache alone when the seed is purely content (no schema changes)", async () => {
		await seedExistingPagesWithBody(db, "json");

		const options = new OptionsRepository(db);
		await options.set(MANIFEST_CACHE_KEY, {
			key: "fresh-key",
			manifest: { fresh: true },
		});

		const contentOnly: SeedFile = {
			version: "1",
			content: {
				pages: [
					{
						id: "page-1",
						slug: "hello",
						status: "published",
						data: { title: "Hello", body: { layout: [] } },
					},
				],
			},
		};

		await applySeed(db, contentOnly, { includeContent: true });

		const cached = await options.get<{ key: string; manifest: { fresh?: boolean } }>(
			MANIFEST_CACHE_KEY,
		);
		expect(cached).not.toBeNull();
		expect(cached?.key).toBe("fresh-key");
	});
});
