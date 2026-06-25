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
	afterSchedule: (event: ContentPublishStateChangeEvent) => void,
	afterUnschedule: (event: ContentPublishStateChangeEvent) => void,
): EmDashRuntime {
	const plugin = definePlugin({
		id: "schedule-sync-test",
		version: "1.0.0",
		capabilities: ["content:read"],
		hooks: {
			"content:afterSchedule": (event) => {
				afterSchedule(event);
			},
			"content:afterUnschedule": (event) => {
				afterUnschedule(event);
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

describe("content scheduling hooks", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;
	let afterSchedule: ReturnType<typeof vi.fn>;
	let afterUnschedule: ReturnType<typeof vi.fn>;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		repo = new ContentRepository(db);
		afterSchedule = vi.fn();
		afterUnschedule = vi.fn();
		runtime = buildRuntime(db, afterSchedule, afterUnschedule);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("fires content:afterSchedule when a draft is scheduled", async () => {
		const item = await repo.create({
			type: "post",
			slug: "scheduled-post",
			status: "draft",
			data: { title: "Scheduled post" },
		});
		const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();

		const result = await runtime.handleContentSchedule("post", item.id, scheduledAt);
		await flushDeferredHooks();

		expect(result.success).toBe(true);
		expect(afterSchedule).toHaveBeenCalledTimes(1);
		expect(afterSchedule).toHaveBeenCalledWith(
			expect.objectContaining({
				collection: "post",
				content: expect.objectContaining({
					id: item.id,
					status: "scheduled",
					scheduledAt,
				}),
			}),
		);
	});

	it("fires content:afterUnschedule when scheduled content is unscheduled", async () => {
		const item = await repo.create({
			type: "post",
			slug: "scheduled-post",
			status: "draft",
			data: { title: "Scheduled post" },
		});
		const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
		await repo.schedule("post", item.id, scheduledAt);

		const result = await runtime.handleContentUnschedule("post", item.id);
		await flushDeferredHooks();

		expect(result.success).toBe(true);
		expect(afterUnschedule).toHaveBeenCalledTimes(1);
		expect(afterUnschedule).toHaveBeenCalledWith(
			expect.objectContaining({
				collection: "post",
				content: expect.objectContaining({
					id: item.id,
					status: "draft",
					scheduledAt: null,
				}),
			}),
		);
	});
});
