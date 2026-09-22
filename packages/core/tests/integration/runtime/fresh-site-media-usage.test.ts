import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
	"virtual:emdash/seed",
	() => ({
		seed: {
			version: "1",
			settings: {},
			collections: [
				{
					slug: "posts",
					label: "Posts",
					fields: [{ slug: "hero", label: "Hero", type: "image" }],
				},
			],
			content: {
				posts: [
					{
						id: "welcome",
						slug: "welcome",
						data: {
							hero: { id: "media-1", provider: "local", mimeType: "image/webp" },
						},
					},
				],
			},
		},
		userSeed: null,
	}),
	{ virtual: true },
);

import { runMigrations } from "../../../src/database/migrations/runner.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database as EmDashDatabase } from "../../../src/database/types.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { verifyMediaUsageCaptureTriggers } from "../../../src/media/usage/capture-triggers.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { applySeed } from "../../../src/seed/apply.js";
import { loadSeed } from "../../../src/seed/load.js";

describe("fresh-site media usage tracking", () => {
	let runtime: EmDashRuntime | undefined;
	let setupDb: Kysely<EmDashDatabase> | undefined;

	afterEach(async () => {
		await runtime?.stopCron();
		await setupDb?.destroy();
		runtime = undefined;
		setupDb = undefined;
	});

	it("activates capture before creating seeded collections", async () => {
		runtime = await EmDashRuntime.create(createDeps());

		const activation = await runtime.db
			.selectFrom("_emdash_media_usage_activation")
			.select(["state", "activated_at"])
			.where("task_key", "=", "incremental_capture")
			.executeTakeFirstOrThrow();
		expect(activation).toEqual({ state: "active", activated_at: expect.any(String) });

		const collection = await new SchemaRegistry(runtime.db).getCollection("posts");
		if (!collection) throw new Error("Expected seeded posts collection");
		expect(
			await verifyMediaUsageCaptureTriggers(runtime.db, {
				collectionId: collection.id,
				collectionSlug: collection.slug,
			}),
		).toBe(true);

		await applySeed(runtime.db, await loadSeed(), { includeContent: true, onConflict: "skip" });
		const content = await runtime.db
			.selectFrom("ec_posts")
			.select("id")
			.where("slug", "=", "welcome")
			.executeTakeFirstOrThrow();
		expect(
			await runtime.db
				.selectFrom("_emdash_media_usage_work")
				.select(["collection_id", "content_id", "state"])
				.execute(),
		).toEqual([{ collection_id: collection.id, content_id: content.id, state: "pending" }]);
	});

	it("leaves an existing configured site inactive", async () => {
		const sqlite = new Database(":memory:");
		setupDb = new Kysely<EmDashDatabase>({
			dialect: new SqliteDialect({ database: sqlite }),
		});
		await runMigrations(setupDb);
		await new SchemaRegistry(setupDb).createCollection({ slug: "articles", label: "Articles" });
		await new OptionsRepository(setupDb).set("emdash:setup_complete", true);

		runtime = await EmDashRuntime.create({
			...createDeps(),
			createDialect: () => new SqliteDialect({ database: sqlite }),
		});

		expect(
			await runtime.db
				.selectFrom("_emdash_media_usage_activation")
				.select(["state", "activated_at"])
				.where("task_key", "=", "incremental_capture")
				.executeTakeFirstOrThrow(),
		).toEqual({ state: "expanded", activated_at: null });
	});
});

function createDeps(): RuntimeDependencies {
	return {
		config: {
			database: {
				entrypoint: `fresh-site-media-usage-${randomUUID()}`,
				config: {},
				type: "sqlite",
			},
		},
		plugins: [],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};
}
