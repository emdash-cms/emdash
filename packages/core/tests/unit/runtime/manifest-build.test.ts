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

import { generateManifest } from "../../../src/api/handlers/manifest.js";
import type { EmDashConfig } from "../../../src/astro/integration/runtime.js";
import type { Database } from "../../../src/database/types.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { createHookPipeline } from "../../../src/plugins/hooks.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const zodString = { _def: { typeName: "ZodString" } };
const zodNumber = { _def: { typeName: "ZodNumber" } };

const configCollections = {
	posts: {
		schema: {
			shape: {
				title: zodString,
				views: zodNumber,
			},
		},
		admin: {
			label: "Posts",
			labelSingular: "Post",
			supports: ["preview"],
		},
	},
	pages: {
		schema: {
			shape: {
				heading: zodString,
			},
		},
		admin: {
			label: "Pages",
			labelSingular: "Page",
			supports: [],
		},
	},
};

function buildRuntime(db: Kysely<Database>): EmDashRuntime {
	const config: EmDashConfig = {};
	const pipelineFactoryOptions = { db } as const;
	const hooks = createHookPipeline([], pipelineFactoryOptions);
	const pipelineRef = { current: hooks };
	const runtimeDeps = {
		config,
		plugins: [],
		// eslint-disable-next-line typescript/no-explicit-any -- match RuntimeDependencies signature
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

describe("generateManifest()", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("merges runtime manual collections from the database with config collections", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "currents",
			label: "Currents",
			labelSingular: "Current",
			source: "manual",
			supports: ["drafts", "preview"],
		});
		await registry.createField("currents", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});
		await registry.createField("currents", {
			slug: "priority",
			label: "Priority",
			type: "integer",
		});

		const manifest = await generateManifest(configCollections, {}, { db });

		expect(Object.keys(manifest.collections).toSorted()).toEqual(["currents", "pages", "posts"]);
		expect(manifest.collections.currents).toMatchObject({
			label: "Currents",
			labelSingular: "Current",
			supports: ["drafts", "preview"],
		});
		expect(manifest.collections.currents?.fields.title).toMatchObject({
			kind: "string",
			label: "Title",
			required: true,
		});
		expect(manifest.collections.currents?.fields.priority).toMatchObject({
			kind: "number",
			label: "Priority",
		});
	});

	it("keeps config collection fields when the database has the same slug", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "posts",
			label: "DB Posts",
			labelSingular: "DB Post",
			source: "manual",
		});
		await registry.createField("posts", { slug: "body", label: "Body", type: "text" });

		const manifest = await generateManifest({ posts: configCollections.posts }, {}, { db });

		expect(manifest.collections.posts?.label).toBe("Posts");
		expect(Object.keys(manifest.collections.posts?.fields ?? {}).toSorted()).toEqual([
			"title",
			"views",
		]);
		expect(manifest.collections.posts?.fields.body).toBeUndefined();
	});

	it("includes manual collections that have no fields", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "links",
			label: "Links",
			labelSingular: "Link",
			source: "manual",
		});

		const manifest = await generateManifest({}, {}, { db });

		expect(manifest.collections.links).toBeDefined();
		expect(manifest.collections.links?.fields).toEqual({});
	});

	it("changes the hash when a manual collection is added", async () => {
		const registry = new SchemaRegistry(db);
		const before = await generateManifest(configCollections, {}, { db });

		await registry.createCollection({
			slug: "currents",
			label: "Currents",
			labelSingular: "Current",
			source: "manual",
		});

		const after = await generateManifest(configCollections, {}, { db });

		expect(after.hash).not.toBe(before.hash);
	});

	it("falls back to config collections when database collection loading fails", async () => {
		const failingDb = {
			selectFrom() {
				throw new Error("missing registry tables");
			},
		} as unknown as Kysely<Database>;

		const manifest = await generateManifest(configCollections, {}, { db: failingDb });

		expect(Object.keys(manifest.collections).toSorted()).toEqual(["pages", "posts"]);
		expect(manifest.collections.posts?.fields.title?.kind).toBe("string");
	});

	it("falls back to a text descriptor for unknown database field types", async () => {
		const registry = new SchemaRegistry(db);
		const collection = await registry.createCollection({
			slug: "imports",
			label: "Imports",
			labelSingular: "Import",
			source: "manual",
		});
		await db
			.insertInto("_emdash_fields")
			.values({
				id: "field_unknown_type",
				collection_id: collection.id,
				slug: "payload",
				label: "Payload",
				type: "unknown_plugin_type",
				column_type: "TEXT",
				required: 0,
				unique: 0,
				default_value: null,
				validation: null,
				widget: null,
				options: null,
				sort_order: 0,
			})
			.execute();

		const manifest = await generateManifest({}, {}, { db });

		expect(manifest.collections.imports?.fields.payload).toMatchObject({
			kind: "string",
			label: "Payload",
		});
	});
});

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
