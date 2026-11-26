import { randomUUID } from "node:crypto";

import { sql, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { mediaCacheTag } from "../../../src/media/image-endpoint.js";
import { CronAccessImpl } from "../../../src/plugins/cron.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { ContentAfterPublishHandler, PluginContext } from "../../../src/plugins/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import type { Storage } from "../../../src/storage/types.js";

function createFakeStorage(): { storage: Storage; files: Set<string> } {
	const files = new Set<string>();
	const storage: Storage = {
		async upload(options) {
			files.add(options.key);
			return { key: options.key, size: 0 };
		},
		async download() {
			throw new Error("not implemented");
		},
		async delete(key) {
			files.delete(key);
		},
		async exists(key) {
			return files.has(key);
		},
		async list() {
			return { items: [] };
		},
		async getSignedUploadUrl(options) {
			return {
				url: `https://signed.example.com/${options.key}`,
				method: "PUT",
				headers: {},
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			};
		},
		getPublicUrl(key) {
			return `/media/${key}`;
		},
	};
	return { storage, files };
}

describe("scheduled plugin cache invalidation", () => {
	let runtime: EmDashRuntime;
	let ids: string[];
	let task: (ctx: PluginContext) => Promise<void>;
	let afterPublication: ContentAfterPublishHandler;
	let now: Date | undefined;
	let files: Set<string>;

	async function publish(ctx: PluginContext, id: string) {
		if (!ctx.content?.getVersioned || !ctx.content.publish) {
			throw new Error("Publication access unavailable");
		}
		const current = await ctx.content.getVersioned("post", id);
		if (!current) throw new Error("Content not found");
		await ctx.content.publish("post", id, { _rev: current._rev });
	}

	beforeEach(async () => {
		task = async () => {};
		afterPublication = async () => {};
		now = undefined;
		const fake = createFakeStorage();
		files = fake.files;
		const entrypoint = `test-scheduled-cache-${randomUUID()}`;
		runtime = await EmDashRuntime.create({
			config: {
				database: { entrypoint, config: {}, type: "sqlite" },
				storage: { entrypoint, config: {} },
			},
			plugins: [
				definePlugin({
					id: "importer",
					version: "1.0.0",
					capabilities: ["content:publish", "media:write"],
					hooks: {
						cron: { handler: async (_event, ctx) => task(ctx) },
						"content:afterPublish": {
							handler: async (event, ctx) => afterPublication(event, ctx),
						},
					},
					routes: { publish: { handler: async (ctx) => publish(ctx, ids[1]!) } },
				}),
			],
			createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
			createStorage: () => fake.storage,
			now: () => now ?? new Date(),
			createScheduler: null,
			sandboxEnabled: false,
			sandboxedPluginEntries: [],
			createSandboxRunner: null,
		});
		await new SchemaRegistry(runtime.db).createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
		});
		ids = [];
		for (const slug of ["first", "second"]) {
			const item = await new ContentRepository(runtime.db).create({
				type: "post",
				slug,
				status: "draft",
				data: {},
			});
			ids.push(item.id);
		}
	});

	afterEach(async () => {
		await runtime.stopCron();
	});

	async function schedule(name = "import") {
		await new CronAccessImpl(runtime.db, "importer", () => {}).schedule(name, {
			schedule: new Date(Date.now() - 60_000).toISOString(),
		});
	}

	it("purges deduplicated tags once after all due plugin tasks finish", async () => {
		const invalidate = vi.fn(async (_tags: string[]) => {});
		const callsDuringTasks: number[] = [];
		let index = 0;
		task = async (ctx) => {
			await publish(ctx, ids[index++]!);
			callsDuringTasks.push(invalidate.mock.calls.length);
		};
		await schedule("first");
		await schedule("second");

		await runtime.runScheduledTasks({ invalidateContentCache: invalidate });

		expect(index).toBe(2);
		expect(callsDuringTasks).toEqual([0, 0]);
		expect(invalidate).toHaveBeenCalledExactlyOnceWith(["post", ...ids]);
		for (const id of ids) {
			expect((await new ContentRepository(runtime.db).findById("post", id))?.status).toBe(
				"published",
			);
		}
	});

	it("purges committed actions even when the task throws", async () => {
		const invalidate = vi.fn(async (_tags: string[]) => {});
		task = async (ctx) => {
			await publish(ctx, ids[0]!);
			throw new Error("Import failed after publication");
		};
		await schedule();

		await expect(
			runtime.runScheduledTasks({ invalidateContentCache: invalidate }),
		).resolves.toEqual({ published: [] });
		expect(invalidate).toHaveBeenCalledExactlyOnceWith(["post", ids[0]]);
	});

	it("flushes when executor bookkeeping fails after a committed write", async () => {
		const invalidate = vi.fn(async (_tags: string[]) => {});
		task = async (ctx) => publish(ctx, ids[0]!);
		await schedule();
		await sql`
			CREATE TRIGGER reject_task_delete BEFORE DELETE ON _emdash_cron_tasks
			BEGIN SELECT RAISE(ABORT, 'bookkeeping failed'); END
		`.execute(runtime.db);

		await runtime.runScheduledTasks({ invalidateContentCache: invalidate });

		expect(invalidate).toHaveBeenCalledExactlyOnceWith(["post", ids[0]]);
	});

	it("keeps concurrent HTTP actions immediate and preserves the default invalidator", async () => {
		const invalidate = vi.fn(async (_tags: string[]) => {});
		const defaultInvalidate = vi.fn(async (_tags: string[]) => {});
		runtime.setPluginContentCacheInvalidator(defaultInvalidate);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		task = async (ctx) => {
			await publish(ctx, ids[0]!);
			started.resolve();
			await release.promise;
		};
		await schedule();
		const tick = runtime.runScheduledTasks({ invalidateContentCache: invalidate });
		try {
			await started.promise;
			const result = await runtime.handlePluginApiRoute(
				"importer",
				"POST",
				"/publish",
				new Request("http://test.local/publish", { method: "POST" }),
			);
			expect(result.success).toBe(true);
			expect(defaultInvalidate).toHaveBeenCalledExactlyOnceWith(["post", ids[1]]);
			expect(invalidate).not.toHaveBeenCalled();
		} finally {
			release.resolve();
			await tick;
		}
		expect(invalidate).toHaveBeenCalledExactlyOnceWith(["post", ids[0]]);
	});

	it("uses a fresh batch on each tick and skips purges when no actions ran", async () => {
		const invalidate = vi.fn(async (_tags: string[]) => {});
		runtime.setPluginContentCacheInvalidator(invalidate);
		task = async (ctx) => publish(ctx, ids[0]!);
		await schedule();
		await runtime.runScheduledTasks();
		task = async (ctx) => publish(ctx, ids[1]!);
		await schedule();
		await runtime.runScheduledTasks();
		await runtime.runScheduledTasks();

		expect(invalidate.mock.calls).toEqual([[["post", ids[0]]], [["post", ids[1]]]]);
	});

	it("keeps maintenance non-fatal when the batched purge fails", async () => {
		const invalidate = vi.fn(async () => {
			throw new Error("provider unavailable");
		});
		task = async (ctx) => publish(ctx, ids[0]!);
		await schedule();

		await expect(
			runtime.runScheduledTasksWithStats({ invalidateContentCache: invalidate }),
		).resolves.toEqual({ processed: 1, published: [] });
		expect(invalidate).toHaveBeenCalledOnce();
	});

	it("immediately purges actions from a hook that outlives its tick", async () => {
		const invalidate = vi.fn(async (_tags: string[]) => {});
		const release = Promise.withResolvers<void>();
		let lateAction: Promise<void> | undefined;
		task = async (ctx) => {
			lateAction = release.promise.then(() => publish(ctx, ids[1]!));
			await publish(ctx, ids[0]!);
		};
		await schedule();
		try {
			await runtime.runScheduledTasks({ invalidateContentCache: invalidate });
			expect(invalidate).toHaveBeenCalledExactlyOnceWith(["post", ids[0]]);
		} finally {
			release.resolve();
			await lateAction;
		}
		expect(invalidate.mock.calls).toEqual([[["post", ids[0]]], [["post", ids[1]]]]);
	});

	it("invalidates writes from scheduled publication hooks even after maintenance returns", async () => {
		const invalidate = vi.fn(async (_tags: string[]) => {});
		const onPublished = vi.fn(async () => {});
		const release = Promise.withResolvers<void>();
		afterPublication = async (event, ctx) => {
			if (event.content.id !== ids[0]) return;
			await release.promise;
			await publish(ctx, ids[1]!);
		};
		const repo = new ContentRepository(runtime.db);
		await repo.update("post", ids[0]!, {
			status: "scheduled",
			scheduledAt: new Date(Date.now() - 60_000).toISOString(),
		});
		try {
			await expect(
				runtime.runScheduledTasks({ invalidateContentCache: invalidate, onPublished }),
			).resolves.toEqual({ published: [{ collection: "post", id: ids[0] }] });
			expect(onPublished).toHaveBeenCalledExactlyOnceWith([{ collection: "post", id: ids[0] }]);
			expect(invalidate).not.toHaveBeenCalled();
		} finally {
			release.resolve();
			await waitForDeferredTasks();
		}

		expect((await repo.findById("post", ids[1]!))?.status).toBe("published");
		expect(invalidate).toHaveBeenCalledExactlyOnceWith(["post", ids[1]]);
	});

	it("purges the media tag of a file a plugin task deletes, once after the tick", async () => {
		const invalidate = vi.fn(async (_tags: string[]) => {});
		const callsDuringTask: number[] = [];
		let storageKey: string | undefined;
		task = async (ctx) => {
			const uploaded = await ctx.media!.upload!(
				"doomed.png",
				"image/png",
				new Uint8Array([1, 2, 3, 4]).buffer,
			);
			storageKey = uploaded.storageKey;
			await ctx.media!.delete!(uploaded.mediaId);
			callsDuringTask.push(invalidate.mock.calls.length);
		};
		await schedule();

		await runtime.runScheduledTasks({ invalidateContentCache: invalidate });

		expect(storageKey).toBeDefined();
		expect(files.has(storageKey!)).toBe(false);
		expect(callsDuringTask).toEqual([0]);
		expect(invalidate).toHaveBeenCalledExactlyOnceWith([mediaCacheTag(storageKey!)]);
	});

	it("purges the media tags of upload files removed by the hourly cleanup", async () => {
		const invalidate = vi.fn(async (_tags: string[]) => {});
		const storageKey = "abandoned-upload.png";
		files.add(storageKey);
		await new MediaRepository(runtime.db).trackStorageKeyForCleanup("orphan-media", storageKey);
		now = new Date("2026-11-04T13:00:00Z");

		await runtime.runScheduledTasks({ invalidateContentCache: invalidate });

		expect(files.has(storageKey)).toBe(false);
		expect(invalidate).toHaveBeenCalledExactlyOnceWith([mediaCacheTag(storageKey)]);
	});
});
