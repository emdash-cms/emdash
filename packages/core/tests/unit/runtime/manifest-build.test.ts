/**
 * Closes the bug class behind #776, #873, #876, #877.
 *
 * The earlier failure mode was a worker-isolate manifest cache: schema
 * mutations on isolate A weren't visible to warm sibling isolates until
 * they were recycled, producing the "Collection 'X' not found" coin flip
 * that all four issues described from a different angle.
 *
 * The runtime no longer caches the manifest. Every admin request rebuilds
 * it from the live database via two queries (`listCollectionsWithFields`),
 * deduplicated within the request by `requestCached`. This test pins the
 * "always fresh" contract by simulating two isolates as two `EmDashRuntime`
 * instances against the same database — a mutation through one is visible
 * through the other on the very next call.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EmDashConfig } from "../../../src/astro/integration/runtime.js";
import type { Database } from "../../../src/database/types.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { createHookPipeline } from "../../../src/plugins/hooks.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function buildRuntime(db: Kysely<Database>): EmDashRuntime {
	const config: EmDashConfig = {};
	const pipelineFactoryOptions = { db } as const;
	const hooks = createHookPipeline([], pipelineFactoryOptions);
	const pipelineRef = { current: hooks };
	const runtimeDeps = {
		config,
		plugins: [],
		// eslint-disable-next-line typescript-eslint(no-explicit-any) -- match RuntimeDependencies signature
		createDialect: (() => {
			throw new Error("createDialect not used in this test");
		}) as any,
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};

	return new EmDashRuntime({
		db,
		storage: null,
		configuredPlugins: [],
		sandboxedPlugins: new Map(),
		sandboxedPluginEntries: [],
		hooks,
		enabledPlugins: new Set(),
		pluginStates: new Map(),
		config,
		mediaProviders: new Map(),
		mediaProviderEntries: [],
		cronExecutor: null,
		cronScheduler: null,
		emailPipeline: null,
		allPipelinePlugins: [],
		pipelineFactoryOptions,
		runtimeDeps,
		pipelineRef,
	});
}

describe("EmDashRuntime.getManifest()", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("reflects schema mutations immediately, with no cross-runtime cache", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "posts",
			label: "Posts",
			labelSingular: "Post",
			source: "test",
		});

		const runtimeA = buildRuntime(db);
		const runtimeB = buildRuntime(db);

		const initialA = await runtimeA.getManifest();
		const initialB = await runtimeB.getManifest();
		expect(Object.keys(initialA.collections)).toEqual(["posts"]);
		expect(Object.keys(initialB.collections)).toEqual(["posts"]);

		// A schema mutation through any path (admin route, MCP, seed, direct
		// registry) is visible through every runtime instance on the next
		// `getManifest()` call. No invalidation step required.
		await registry.createCollection({
			slug: "pages",
			label: "Pages",
			labelSingular: "Page",
			source: "test",
		});

		const updatedA = await runtimeA.getManifest();
		const updatedB = await runtimeB.getManifest();
		expect(Object.keys(updatedA.collections).toSorted()).toEqual(["pages", "posts"]);
		expect(Object.keys(updatedB.collections).toSorted()).toEqual(["pages", "posts"]);
	});

	it("includes field definitions built via the two-query JOIN (one collection)", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "posts",
			label: "Posts",
			labelSingular: "Post",
			source: "test",
		});
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "body", label: "Body", type: "json" });

		const runtime = buildRuntime(db);
		const manifest = await runtime.getManifest();

		const posts = manifest.collections.posts;
		expect(posts).toBeDefined();
		expect(posts?.fields.title?.kind).toBe("string");
		expect(posts?.fields.body?.kind).toBe("json");
	});

	it("includes field definitions for many collections in two queries flat", async () => {
		const registry = new SchemaRegistry(db);
		for (let i = 0; i < 5; i++) {
			await registry.createCollection({
				slug: `coll_${i}`,
				label: `Coll ${i}`,
				labelSingular: `Coll ${i}`,
				source: "test",
			});
			await registry.createField(`coll_${i}`, {
				slug: "title",
				label: "Title",
				type: "string",
			});
		}

		const runtime = buildRuntime(db);
		const manifest = await runtime.getManifest();

		expect(Object.keys(manifest.collections).toSorted()).toEqual([
			"coll_0",
			"coll_1",
			"coll_2",
			"coll_3",
			"coll_4",
		]);
		for (let i = 0; i < 5; i++) {
			expect(manifest.collections[`coll_${i}`]?.fields.title?.kind).toBe("string");
		}
	});
});
