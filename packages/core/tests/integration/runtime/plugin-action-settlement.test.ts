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
import type { ContentAfterPublishHandler } from "../../../src/plugins/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

const afterPublish = vi.fn<ContentAfterPublishHandler>(async () => undefined);
let contentActions: ContentActionCallbacks;
let cronTargetId = "";
let loadedSandboxCapabilities: string[] = [];
const routeGates = new Map<string, Promise<void>>();

function routeContentId(input: unknown): string {
	if (
		typeof input !== "object" ||
		input === null ||
		!("id" in input) ||
		typeof input.id !== "string"
	) {
		throw new Error("Missing content id");
	}
	return input.id;
}

function createDeps(pluginId: string): RuntimeDependencies {
	const runner = {
		isAvailable: () => true,
		isHealthy: () => true,
		load: vi.fn(async (manifest: { id: string; version: string; capabilities: string[] }) => {
			loadedSandboxCapabilities = [...manifest.capabilities];
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
				capabilities: ["content:publish"],
				hooks: { "content:afterPublish": { handler: afterPublish } },
			}),
			definePlugin({
				id: "route-publisher",
				version: "1.0.0",
				capabilities: ["content:publish"],
				routes: {
					publish: {
						handler: async (ctx) => {
							const id = routeContentId(ctx.input);
							await routeGates.get(id);
							const current = await ctx.content?.getVersioned?.("post", id);
							if (!current || !ctx.content?.publish)
								throw new Error("Publication access unavailable");
							return ctx.content.publish("post", id, { _rev: current._rev });
						},
					},
				},
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
		afterPublish.mockImplementation(async () => undefined);
		routeGates.clear();
		runtime.setPluginContentCacheInvalidator(undefined);
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

	function publicationRequest(id: string): Request {
		return new Request("http://test.local/_emdash/api/plugin/route-publisher/publish", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id }),
		});
	}

	it("loads configured sandbox publication capability with implied content reads", () => {
		expect(loadedSandboxCapabilities).toEqual(
			expect.arrayContaining(["content:publish", "content:read"]),
		);
	});

	it("preserves the complete plugin content item contract for versioned reads", async () => {
		const item = await new ContentRepository(runtime.db).create({
			type: "post",
			slug: `entry-${randomUUID()}`,
			status: "draft",
			authorId: "author-1",
			data: {},
		});
		const current = await contentActions.getVersioned(pluginId, "post", item.id);

		expect(current?.item).toMatchObject({
			authorId: item.authorId,
			translationGroup: item.translationGroup,
			liveRevisionId: item.liveRevisionId,
			draftRevisionId: item.draftRevisionId,
			version: item.version,
		});
	});

	it("blocks plugin publication while media usage activation is in progress", async () => {
		const item = await draft();
		const current = await contentActions.getVersioned(pluginId, "post", item.id);
		if (!current) throw new Error("Content not found");
		const activation = await runtime.db
			.selectFrom("_emdash_media_usage_activation")
			.select("state")
			.where("task_key", "=", "incremental_capture")
			.executeTakeFirstOrThrow();

		await runtime.db
			.updateTable("_emdash_media_usage_activation")
			.set({ state: "activating" })
			.where("task_key", "=", "incremental_capture")
			.execute();
		try {
			await expect(
				contentActions.publish(pluginId, "post", item.id, { _rev: current._rev }),
			).rejects.toMatchObject({ code: "MEDIA_USAGE_ACTIVATION_IN_PROGRESS" });
			expect(
				(await new ContentRepository(runtime.db).findByIdOrSlug("post", item.id))?.status,
			).toBe("draft");
		} finally {
			await runtime.db
				.updateTable("_emdash_media_usage_activation")
				.set({ state: activation.state })
				.where("task_key", "=", "incremental_capture")
				.execute();
		}
	});

	it("blocks cross-action reentrancy while publication after-hooks settle", async () => {
		const item = await draft();
		const current = await contentActions.getVersioned(pluginId, "post", item.id);
		if (!current) throw new Error("Content not found");
		let nestedErrorCode = "";
		afterPublish.mockImplementationOnce(async (event, ctx) => {
			const nested = await ctx.content?.getVersioned?.("post", String(event.content.id));
			if (!nested || !ctx.content?.unpublish) throw new Error("Publication access unavailable");
			try {
				await ctx.content.unpublish("post", String(event.content.id), { _rev: nested._rev });
			} catch (error) {
				nestedErrorCode =
					typeof error === "object" && error !== null && "code" in error
						? String(error.code)
						: "UNKNOWN";
			}
		});

		await contentActions.publish(pluginId, "post", item.id, { _rev: current._rev });
		await flushDeferred();

		expect(nestedErrorCode).toBe("CONTENT_ACTION_REENTRANT");
		expect(afterPublish).toHaveBeenCalledOnce();
	});

	it("keeps concurrent route invalidators scoped to their own request", async () => {
		const [first, second] = await Promise.all([draft(), draft()]);
		let releaseFirst: () => void = () => undefined;
		let releaseSecond: () => void = () => undefined;
		routeGates.set(first.id, new Promise<void>((resolve) => (releaseFirst = resolve)));
		routeGates.set(second.id, new Promise<void>((resolve) => (releaseSecond = resolve)));
		const invalidateFirst = vi.fn().mockResolvedValue(undefined);
		const invalidateSecond = vi.fn().mockResolvedValue(undefined);

		const firstResult = runtime.handlePluginApiRoute(
			"route-publisher",
			"POST",
			"publish",
			publicationRequest(first.id),
			null,
			invalidateFirst,
		);
		const secondResult = runtime.handlePluginApiRoute(
			"route-publisher",
			"POST",
			"publish",
			publicationRequest(second.id),
			null,
			invalidateSecond,
		);
		releaseSecond();
		releaseFirst();
		expect((await firstResult).success).toBe(true);
		expect((await secondResult).success).toBe(true);

		expect(invalidateFirst).toHaveBeenCalledWith(["post", first.id]);
		expect(invalidateFirst).toHaveBeenCalledTimes(1);
		expect(invalidateSecond).toHaveBeenCalledWith(["post", second.id]);
		expect(invalidateSecond).toHaveBeenCalledTimes(1);
	});

	it("does not turn committed publication into a failure when invalidation rejects", async () => {
		const item = await draft();
		const invalidateError = new Error("cache unavailable");
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const result = await runtime.handlePluginApiRoute(
				"route-publisher",
				"POST",
				"publish",
				publicationRequest(item.id),
				null,
				vi.fn().mockRejectedValue(invalidateError),
			);

			expect(result.success).toBe(true);
			expect(
				(await new ContentRepository(runtime.db).findByIdOrSlug("post", item.id))?.status,
			).toBe("published");
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining("Cache invalidation failed"),
				invalidateError,
			);
		} finally {
			log.mockRestore();
		}
	});

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
		const invalidate = vi.fn().mockResolvedValue(undefined);

		contentActions.begin?.(pluginId, invocationId, invalidate);
		await contentActions.flush(pluginId, invocationId, false);
		await contentActions.publish(pluginId, "post", item.id, { _rev: current._rev }, invocationId);
		await flushDeferred();

		expect(invalidate).toHaveBeenCalledWith(["post", item.id]);
		expect(afterPublish).toHaveBeenCalledOnce();
		await contentActions.flush(pluginId, invocationId, true);
		await flushDeferred();
		expect(afterPublish).toHaveBeenCalledOnce();
	});

	it("retains invalidation for an admitted action that commits after expiry cleanup", async () => {
		vi.useFakeTimers();
		const item = await draft();
		const current = await contentActions.getVersioned(pluginId, "post", item.id);
		if (!current) throw new Error("Content not found");
		const invocationId = randomUUID();
		const invalidate = vi.fn().mockResolvedValue(undefined);
		let releasePublish: () => void = () => undefined;
		let markStarted: () => void = () => undefined;
		const publishGate = new Promise<void>((resolve) => (releasePublish = resolve));
		const started = new Promise<void>((resolve) => (markStarted = resolve));
		const originalPublish = runtime.handleContentPublish.bind(runtime);
		const publishSpy = vi
			.spyOn(runtime, "handleContentPublish")
			.mockImplementation(async (...args) => {
				markStarted();
				await publishGate;
				return originalPublish(...args);
			});

		try {
			contentActions.begin?.(pluginId, invocationId, invalidate);
			await contentActions.flush(pluginId, invocationId, false);
			const action = contentActions.publish(
				pluginId,
				"post",
				item.id,
				{ _rev: current._rev },
				invocationId,
			);
			await started;
			await vi.advanceTimersByTimeAsync(60_000);
			releasePublish();
			await action;

			expect(invalidate).toHaveBeenCalledWith(["post", item.id]);
		} finally {
			publishSpy.mockRestore();
		}
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

	it("rejects actions after timeout state and invalidation context expire", async () => {
		vi.useFakeTimers();
		const item = await draft();
		const current = await contentActions.getVersioned(pluginId, "post", item.id);
		if (!current) throw new Error("Content not found");
		const invocationId = randomUUID();
		const invalidate = vi.fn().mockResolvedValue(undefined);

		contentActions.begin?.(pluginId, invocationId, invalidate);
		await contentActions.flush(pluginId, invocationId, false);
		await vi.advanceTimersByTimeAsync(60_000);
		await expect(
			contentActions.publish(pluginId, "post", item.id, { _rev: current._rev }, invocationId),
		).rejects.toMatchObject({ code: "CONTENT_ACTION_INVOCATION_EXPIRED" });
		await flushDeferred();

		expect(invalidate).not.toHaveBeenCalled();
		expect((await new ContentRepository(runtime.db).findByIdOrSlug("post", item.id))?.status).toBe(
			"draft",
		);
		expect(afterPublish).not.toHaveBeenCalled();
	});
});
