/**
 * `_buildManifest` copies `field.validation` into the manifest descriptor
 * for reference fields so the admin editor receives the relation,
 * target collection, and cardinality needed by the reference picker.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { EmDashConfig } from "../../src/astro/integration/runtime.js";
import { RelationRepository } from "../../src/database/repositories/relation.js";
import type { Database } from "../../src/database/types.js";
import { EmDashRuntime } from "../../src/emdash-runtime.js";
import { createHookPipeline } from "../../src/plugins/hooks.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../utils/test-db.js";

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

describeEachDialect("manifest reference field validation", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("carries kind and validation for a reference field", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({
			slug: "posts",
			label: "Posts",
			labelSingular: "Post",
			source: "test",
		});
		await registry.createField("posts", {
			slug: "related",
			label: "Related",
			type: "reference",
			validation: { relation: "grp_x", targetCollection: "posts", multiple: true },
		});

		const runtime = buildRuntime(ctx.db);
		const manifest = await runtime.getManifest();

		const entry = manifest.collections.posts?.fields.related;
		expect(entry?.kind).toBe("reference");
		expect(entry?.validation).toMatchObject({
			relation: "grp_x",
			targetCollection: "posts",
			multiple: true,
		});
	});

	it("reports the relation's cardinality as a bound field's `multiple`", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createCollection({ slug: "authors", label: "Authors", labelSingular: "Author" });
		const relations = new RelationRepository(ctx.db);
		await relations.create({
			slug: "post_author",
			parentCollection: "posts",
			childCollection: "authors",
			parentLabel: "Author",
			childLabel: "Posts",
			maxChildrenPerParent: 1,
		});
		// The relation owns cardinality, so whatever the field row still carries
		// from before it was bound has no say in what the picker allows.
		await registry.createField("posts", {
			slug: "author",
			label: "Author",
			type: "reference",
			validation: {
				relation: "post_author",
				relationSide: "parent",
				targetCollection: "authors",
				multiple: true,
			},
		});
		await registry.createField("authors", {
			slug: "posts",
			label: "Posts",
			type: "reference",
			validation: {
				relation: "post_author",
				relationSide: "child",
				targetCollection: "posts",
			},
		});

		const manifest = await buildRuntime(ctx.db).getManifest();

		// One author per post: the parent side holds at most one child.
		expect(manifest.collections.posts?.fields.author?.validation).toMatchObject({
			multiple: false,
		});
		// Unlimited parents per child: the author's own field lists many posts.
		expect(manifest.collections.authors?.fields.posts?.validation).toMatchObject({
			multiple: true,
		});
	});
});
