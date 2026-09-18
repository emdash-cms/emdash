import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { deferred } = vi.hoisted(() => ({ deferred: [] as Array<() => void | Promise<void>> }));
vi.mock("../../../src/after.js", () => ({
	after: (fn: () => void | Promise<void>) => {
		deferred.push(fn);
	},
}));

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import type { ContentActionCallbacks } from "../../../src/plugins/context.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { SandboxedPluginInstance } from "../../../src/plugins/sandbox/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

const afterPublish = vi.fn(async () => undefined);
let contentActions: ContentActionCallbacks;
let cronTargetId = "";

function createDeps(pluginId: string): RuntimeDependencies {
	const runner = {
		isAvailable: () => true,
		isHealthy: () => true,
		load: vi.fn(async (manifest: { id: string; version: string }) => {
			const instance: SandboxedPluginInstance = {
				id: `${manifest.id}:${manifest.version}`,
				invokeHook: vi.fn(),
				invokeRoute: vi.fn(),
				terminate: vi.fn(),
			};
			return instance;
		}),
		setContentActions: (callbacks: ContentActionCallbacks | null) => {
			if (callbacks) contentActions = callbacks;
		},
		setEmailSend: vi.fn(),
		terminateAll: vi.fn(),
	};

	return {
		config: {
			database: {
				entrypoint: `test-plugin-action-settlement-${randomUUID()}`,
				config: {},
				type: "sqlite",
			},
		},
		plugins: [
			definePlugin({
				id: "publication-watcher",
				version: "1.0.0",
				capabilities: ["content:read"],
				hooks: { "content:afterPublish": { handler: afterPublish } },
			}),
			definePlugin({
				id: "cron-publisher",
				version: "1.0.0",
				capabilities: ["content:publish"],
				hooks: {
					cron: {
						handler: async (_event, ctx) => {
							if (!ctx.content?.getVersioned || !ctx.content.publish) {
								throw new Error("Publication access unavailable");
							}
							const current = await ctx.content.getVersioned("post", cronTargetId);
							if (!current) throw new Error("Content not found");
							await ctx.content.publish("post", cronTargetId, { _rev: current._rev });
						},
					},
				},
			}),
		],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		createScheduler: null,
		sandboxEnabled: true,
		sandboxedPluginEntries: [
			{
				id: pluginId,
				version: "1.0.0",
				options: {},
				code: "",
				capabilities: ["content:publish"],
				allowedHosts: [],
				storage: {},
				hooks: [],
				routes: [],
			},
		],
		// eslint-disable-next-line typescript/no-explicit-any -- fake implements the published runner boundary
		createSandboxRunner: (() => runner) as any,
	};
}

async function flushDeferred(): Promise<void> {
	for (const task of deferred.splice(0)) await task();
}

describe("sandboxed plugin action settlement", () => {
	const pluginId = `settlement-${randomUUID()}`;
	let runtime: EmDashRuntime;

	beforeAll(async () => {
		runtime = await EmDashRuntime.create(createDeps(pluginId));
		const registry = new SchemaRegistry(runtime.db);
		await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
	});

	beforeEach(() => {
		vi.useRealTimers();
		deferred.length = 0;
		afterPublish.mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	afterAll(async () => {
		await runtime.shutdown();
		await runtime.db.destroy();
	});

	async function draft() {
		return new ContentRepository(runtime.db).create({
			type: "post",
			slug: `entry-${randomUUID()}`,
			status: "draft",
			data: {},
		});
	}

	it("invalidates an action outside an API route and releases its after-hook once", async () => {
		const item = await draft();
		const current = await contentActions.getVersioned(pluginId, "post", item.id);
		if (!current) throw new Error("Content not found");
		const invalidate = vi.fn().mockResolvedValue(undefined);
		runtime.setPluginContentCacheInvalidator(invalidate);
		const invocationId = randomUUID();

		contentActions.begin?.(pluginId, invocationId);
		await contentActions.publish(pluginId, "post", item.id, { _rev: current._rev }, invocationId);

		expect(invalidate).toHaveBeenCalledWith(["post", item.id]);
		expect(afterPublish).not.toHaveBeenCalled();
		await contentActions.flush(pluginId, invocationId, false);
		await flushDeferred();
		expect(afterPublish).toHaveBeenCalledOnce();

		await contentActions.flush(pluginId, invocationId, true);
		await flushDeferred();
		expect(afterPublish).toHaveBeenCalledOnce();
	});

	it("invalidates publication from a cron hook", async () => {
		const item = await draft();
		cronTargetId = item.id;
		const invalidate = vi.fn().mockResolvedValue(undefined);
		runtime.setPluginContentCacheInvalidator(invalidate);

		const result = await runtime.hooks.invokeCronHook("cron-publisher", {
			name: "publish",
			scheduledAt: "2026-01-01T00:00:00.000Z",
		});

		expect(result.success).toBe(true);
		expect(invalidate).toHaveBeenCalledWith(["post", item.id]);
		expect((await new ContentRepository(runtime.db).findByIdOrSlug("post", item.id))?.status).toBe(
			"published",
		);
	});

	it("self-schedules an after-hook when an action commits after timeout release", async () => {
		const item = await draft();
		const current = await contentActions.getVersioned(pluginId, "post", item.id);
		if (!current) throw new Error("Content not found");
		const invocationId = randomUUID();

		contentActions.begin?.(pluginId, invocationId);
		await contentActions.flush(pluginId, invocationId, false);
		await contentActions.publish(pluginId, "post", item.id, { _rev: current._rev }, invocationId);
		await flushDeferred();

		expect(afterPublish).toHaveBeenCalledOnce();
		await contentActions.flush(pluginId, invocationId, true);
		await flushDeferred();
		expect(afterPublish).toHaveBeenCalledOnce();
	});

	it("invalidates concurrent same-plugin actions independently", async () => {
		const [first, second] = await Promise.all([draft(), draft()]);
		const [firstCurrent, secondCurrent] = await Promise.all([
			contentActions.getVersioned(pluginId, "post", first.id),
			contentActions.getVersioned(pluginId, "post", second.id),
		]);
		if (!firstCurrent || !secondCurrent) throw new Error("Content not found");
		const invalidate = vi.fn().mockResolvedValue(undefined);
		runtime.setPluginContentCacheInvalidator(invalidate);
		const firstInvocation = randomUUID();
		const secondInvocation = randomUUID();

		contentActions.begin?.(pluginId, firstInvocation);
		contentActions.begin?.(pluginId, secondInvocation);
		await Promise.all([
			contentActions.publish(
				pluginId,
				"post",
				first.id,
				{ _rev: firstCurrent._rev },
				firstInvocation,
			),
			contentActions.publish(
				pluginId,
				"post",
				second.id,
				{ _rev: secondCurrent._rev },
				secondInvocation,
			),
		]);

		expect(invalidate).toHaveBeenCalledTimes(2);
		expect(invalidate).toHaveBeenCalledWith(["post", first.id]);
		expect(invalidate).toHaveBeenCalledWith(["post", second.id]);
	});

	it("bounds timeout tombstones without stranding later actions", async () => {
		vi.useFakeTimers();
		const item = await draft();
		const current = await contentActions.getVersioned(pluginId, "post", item.id);
		if (!current) throw new Error("Content not found");
		const invocationId = randomUUID();

		contentActions.begin?.(pluginId, invocationId);
		await contentActions.flush(pluginId, invocationId, false);
		await vi.advanceTimersByTimeAsync(60_000);
		await contentActions.publish(pluginId, "post", item.id, { _rev: current._rev }, invocationId);
		await flushDeferred();

		expect(afterPublish).toHaveBeenCalledOnce();
	});
});
