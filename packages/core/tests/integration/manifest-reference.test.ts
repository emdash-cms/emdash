/**
 * `_buildManifest` copies `field.validation` into the manifest descriptor
 * for `repeater`/`file`/`image` fields, but not `reference` fields. That
 * means the admin editor receives `kind: "reference"` (from
 * `FIELD_TYPE_TO_KIND`) but no `relation` / `targetCollection` / `multiple`
 * config to drive the reference picker widget.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { EmDashConfig } from "../../src/astro/integration/runtime.js";
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
});
