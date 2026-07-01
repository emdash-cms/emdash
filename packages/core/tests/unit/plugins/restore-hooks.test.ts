import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmDashConfig } from "../../../src/astro/integration/runtime.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { createHookPipeline } from "../../../src/plugins/hooks.js";
import type { ContentPublishStateChangeEvent } from "../../../src/plugins/types.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

async function flushDeferredHooks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function buildRuntime(
	db: Kysely<Database>,
	afterRestore: (event: ContentPublishStateChangeEvent) => void,
): EmDashRuntime {
	const plugin = definePlugin({
		id: "restore-sync-test",
		version: "1.0.0",
		capabilities: ["content:read"],
		hooks: {
			"content:afterRestore": (event) => {
				afterRestore(event);
			},
		},
	});
	const config: EmDashConfig = {};
	const pipelineFactoryOptions = { db } as const;
	const hooks = createHookPipeline([plugin], pipelineFactoryOptions);
	const runtimeDeps = {
		config,
		plugins: [plugin],
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
		allPipelinePlugins: [plugin],
		pipelineFactoryOptions,
		runtimeDeps,
		pipelineRef: { current: hooks },
	});
}

describe("content restore hooks", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;
	let afterRestore: ReturnType<typeof vi.fn>;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		repo = new ContentRepository(db);
		afterRestore = vi.fn();
		runtime = buildRuntime(db, afterRestore);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("fires content:afterRestore with the restored content item", async () => {
		const item = await repo.create({
			type: "post",
			slug: "restored-post",
			status: "published",
			data: { title: "Restored post" },
		});
		await repo.delete("post", item.id);

		const result = await runtime.handleContentRestore("post", item.id);
		await flushDeferredHooks();

		expect(result.success).toBe(true);
		if (!result.success) throw new Error("restore failed");
		expect(result.data.item).toEqual(
			expect.objectContaining({
				id: item.id,
				slug: "restored-post",
				status: "published",
			}),
		);
		expect(afterRestore).toHaveBeenCalledTimes(1);
		expect(afterRestore).toHaveBeenCalledWith(
			expect.objectContaining({
				collection: "post",
				content: expect.objectContaining({
					id: item.id,
					slug: "restored-post",
					status: "published",
				}),
			}),
		);
	});
});
