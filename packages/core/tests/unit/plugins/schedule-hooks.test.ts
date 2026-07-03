import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmDashConfig } from "../../../src/astro/integration/runtime.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { createHookPipeline } from "../../../src/plugins/hooks.js";
import type { ContentScheduleStateChangeEvent } from "../../../src/plugins/types.js";
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
	afterSchedule: (event: ContentScheduleStateChangeEvent) => void,
	afterUnschedule: (event: ContentScheduleStateChangeEvent) => void,
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
		deferredTasks.length = 0;
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
		deferredTasks.length = 0;
		const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();

		const result = await runtime.handleContentSchedule("post", item.id, scheduledAt);

		expect(result.success).toBe(true);
		expect(afterSchedule).not.toHaveBeenCalled();

		await flushLatestDeferredHook();

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
		deferredTasks.length = 0;

		const result = await runtime.handleContentUnschedule("post", item.id);

		expect(result.success).toBe(true);
		expect(afterUnschedule).not.toHaveBeenCalled();

		await flushLatestDeferredHook();

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
