import { randomUUID } from "node:crypto";

import memoryProvider from "astro/cache/memory";
import { SqliteDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { CronScheduler, SystemCleanupFn } from "../../../src/plugins/scheduler/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

class CapturingScheduler implements CronScheduler {
	cleanup: SystemCleanupFn | null = null;
	setSystemCleanup(fn: SystemCleanupFn): void {
		this.cleanup = fn;
	}
	start(): void {}
	stop(): void {}
	reschedule(): void {}
}

function createDeps(scheduler: CapturingScheduler, cron: boolean): RuntimeDependencies {
	return {
		config: {
			database: { entrypoint: `test-background-cache-${randomUUID()}`, config: {}, type: "sqlite" },
		},
		plugins: cron
			? [
					definePlugin({
						id: "background-publisher",
						version: "1.0.0",
						capabilities: ["content:publish"],
						hooks: {
							cron: {
								handler: async (_event, ctx) => {
									const current = await ctx.content!.getVersioned!("post", cronTargetId);
									await ctx.content!.publish!("post", cronTargetId, { _rev: current!._rev });
								},
							},
						},
					}),
				]
			: [],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		createScheduler: () => scheduler,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
		now: () => NOW,
	};
}

let cronTargetId = "";

async function createRuntime(scheduler: CapturingScheduler, cron = false) {
	const runtime = await EmDashRuntime.create(createDeps(scheduler, cron));
	await new SchemaRegistry(runtime.db).createCollection({ slug: "post", label: "Posts" });
	return runtime;
}

async function createDraft(runtime: EmDashRuntime) {
	return new ContentRepository(runtime.db).create({
		type: "post",
		slug: `post-${randomUUID()}`,
		status: "draft",
		data: {},
	});
}

function routeCache() {
	return memoryProvider(undefined);
}

async function readRoute(
	provider: ReturnType<typeof routeCache>,
	path: string,
	tags: string[],
	calls: { count: number },
) {
	return provider.onRequest!(
		{
			request: new Request(`http://test.local${path}`),
			url: new URL(`http://test.local${path}`),
			logger: { info() {}, warn() {}, error() {} },
			waitUntil: () => {},
		},
		async () => {
			calls.count++;
			return new Response(`render-${calls.count}`, {
				headers: { "CDN-Cache-Control": "max-age=60", "Cache-Tag": tags.join(",") },
			});
		},
	);
}

describe("background publication route-cache invalidation", () => {
	let runtime: EmDashRuntime | undefined;

	afterEach(async () => {
		if (runtime) {
			await runtime.stopCron();
			await runtime.db.destroy();
			runtime = undefined;
		}
	});

	it.each(["timer", "publishScheduled", "runScheduledTasks", "explicit callback"])(
		"purges scheduled publications through %s",
		async (driver) => {
			const scheduler = new CapturingScheduler();
			runtime = await createRuntime(scheduler);
			const item = await createDraft(runtime);
			const scheduled = await runtime.handleContentSchedule(
				"post",
				item.id,
				new Date(Date.now() + 60_000).toISOString(),
			);
			expect(scheduled.success).toBe(true);
			await runtime.db
				.updateTable("ec_post")
				.set({ scheduled_at: new Date(NOW.getTime() - 1).toISOString() })
				.where("id", "=", item.id)
				.execute();

			const provider = routeCache();
			const calls = { count: 0 };
			await readRoute(provider, "/", ["post"], calls);
			await readRoute(provider, "/article", [item.id], calls);
			await readRoute(provider, "/other", ["other"], calls);
			await readRoute(provider, "/", ["post"], calls);
			await readRoute(provider, "/article", [item.id], calls);
			expect(calls.count).toBe(3);

			runtime.setPluginContentCacheInvalidator((tags) => provider.invalidate({ tags }));
			if (driver === "timer") await scheduler.cleanup!();
			else if (driver === "publishScheduled") await runtime.publishScheduled();
			else if (driver === "runScheduledTasks") await runtime.runScheduledTasks();
			else {
				runtime.setPluginContentCacheInvalidator(() => {
					throw new Error("Explicit callback must take precedence");
				});
				await runtime.runScheduledTasks({
					onPublished: (refs) =>
						provider.invalidate({ tags: refs.flatMap((ref) => [ref.collection, ref.id]) }),
				});
			}

			const home = await readRoute(provider, "/", ["post"], calls);
			const article = await readRoute(provider, "/article", [item.id], calls);
			const unrelated = await readRoute(provider, "/other", ["other"], calls);
			expect(home.headers.get("X-Astro-Cache")).toBe("MISS");
			expect(article.headers.get("X-Astro-Cache")).toBe("MISS");
			expect(unrelated.headers.get("X-Astro-Cache")).toBe("HIT");
		},
	);

	it.each([false, true])(
		"keeps scheduled publishing successful when invalidation is unavailable (failure: %s)",
		async (fails) => {
			const scheduler = new CapturingScheduler();
			runtime = await createRuntime(scheduler);
			const item = await createDraft(runtime);
			await runtime.db
				.updateTable("ec_post")
				.set({ scheduled_at: new Date(NOW.getTime() - 1).toISOString() })
				.where("id", "=", item.id)
				.execute();
			const error = new Error("Provider unavailable");
			if (fails)
				runtime.setPluginContentCacheInvalidator(async () => {
					throw error;
				});
			const log = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				await expect(runtime.publishScheduled()).resolves.toEqual([
					{ collection: "post", id: item.id },
				]);
				expect(
					(await new ContentRepository(runtime.db).findByIdOrSlug("post", item.id))?.status,
				).toBe("published");
				if (fails)
					expect(log).toHaveBeenCalledWith(expect.stringContaining("onPublished failed"), error);
				else expect(log).not.toHaveBeenCalled();
			} finally {
				log.mockRestore();
			}
		},
	);

	it("purges content published by a request-less cron hook", async () => {
		const scheduler = new CapturingScheduler();
		runtime = await createRuntime(scheduler, true);
		const item = await createDraft(runtime);
		cronTargetId = item.id;

		const provider = routeCache();
		const calls = { count: 0 };
		await readRoute(provider, "/", ["post"], calls);
		await readRoute(provider, "/", ["post"], calls);
		runtime.setPluginContentCacheInvalidator((tags) => provider.invalidate({ tags }));
		const result = await runtime.hooks.invokeCronHook("background-publisher", {
			name: "publish",
			scheduledAt: NOW.toISOString(),
		});
		expect(result.success).toBe(true);
		const response = await readRoute(provider, "/", ["post"], calls);
		expect(response.headers.get("X-Astro-Cache")).toBe("MISS");
	});
});
