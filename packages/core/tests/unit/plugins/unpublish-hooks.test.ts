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

const { deferredTasks } = vi.hoisted(() => ({
	deferredTasks: [] as Array<() => void | Promise<void>>,
}));

vi.mock("../../../src/after.js", () => ({
	after: vi.fn((fn: () => void | Promise<void>) => {
		deferredTasks.push(fn);
	}),
}));

async function flushLatestDeferredHook(): Promise<void> {
	const task = deferredTasks.pop();
	if (task) await task();
}

function buildRuntime(
	db: Kysely<Database>,
	afterUnpublish: (event: ContentPublishStateChangeEvent) => void,
): EmDashRuntime {
	const plugin = definePlugin({
		id: "unpublish-sync-test",
		version: "1.0.0",
		capabilities: ["content:read"],
		hooks: {
			"content:afterUnpublish": (event) => {
				afterUnpublish(event);
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
		config: {},
		configuredPlugins: [],
		sandboxedPlugins: new Map(),
		sandboxedPluginEntries: [],
		hooks,
		enabledPlugins: new Set(),
		pluginStates: new Map(),
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

describe("content unpublish hooks", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;
	let afterUnpublish: ReturnType<typeof vi.fn>;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		deferredTasks.length = 0;
		db = await setupTestDatabaseWithCollections();
		repo = new ContentRepository(db);
		afterUnpublish = vi.fn();
		runtime = buildRuntime(db, afterUnpublish);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("defers content:afterUnpublish with the unpublished content item", async () => {
		const item = await repo.create({
			type: "post",
			slug: "published-post",
			status: "published",
			data: { title: "Published post" },
		});
		deferredTasks.length = 0;

		const result = await runtime.handleContentUnpublish("post", item.id);

		expect(result.success).toBe(true);
		expect(afterUnpublish).not.toHaveBeenCalled();

		await flushLatestDeferredHook();

		expect(afterUnpublish).toHaveBeenCalledTimes(1);
		expect(afterUnpublish).toHaveBeenCalledWith(
			expect.objectContaining({
				collection: "post",
				content: expect.objectContaining({
					id: item.id,
					slug: "published-post",
					status: "draft",
				}),
			}),
		);
	});
});
