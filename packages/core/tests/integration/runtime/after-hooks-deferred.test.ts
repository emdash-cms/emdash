/**
 * afterDelete / afterUnpublish hooks must be deferred through `after()`.
 *
 * On Cloudflare Workers, a promise that isn't handed to the host's
 * lifetime extender (`waitUntil`, which `after()` wraps) is canceled the
 * moment the HTTP response is returned. `afterSave` and `afterPublish`
 * already defer their hook dispatch through `after()`; `afterDelete` and
 * `afterUnpublish` historically did not — they fired the hook promise and
 * forgot it. A plugin doing real I/O in those hooks (storage cleanup,
 * search-index removal) would have that work killed mid-flight, which on
 * Workers can wedge the plugin-storage backend and hang every subsequent
 * request in the isolate.
 *
 * These tests pin the contract: deleting or unpublishing content schedules
 * the hook work via `after()` instead of running it inline-and-abandoned.
 */

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Capture-only stub for `after()`: record the deferred task without running
// it, so a test can assert the work was scheduled (not abandoned) and then
// flush it deliberately. Mirrors how Workers holds the promise via waitUntil.
const { deferred } = vi.hoisted(() => ({ deferred: [] as Array<() => void | Promise<void>> }));
vi.mock("../../../src/after.js", () => ({
	after: (fn: () => void | Promise<void>) => {
		deferred.push(fn);
	},
}));

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import type { RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type {
	ContentAfterDeleteHandler,
	ContentAfterUnpublishHandler,
} from "../../../src/plugins/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

const afterDeleteHandler = vi.fn<ContentAfterDeleteHandler>(async () => {});
const afterUnpublishHandler = vi.fn<ContentAfterUnpublishHandler>(async () => {});

function createDeps(sqlite: Database.Database): RuntimeDependencies {
	return {
		config: {
			database: {
				entrypoint: `test-after-hooks-${randomUUID()}`,
				config: {},
				type: "sqlite",
			},
		},
		plugins: [
			definePlugin({
				id: "lifecycle-watcher",
				version: "1.0.0",
				// afterDelete / afterUnpublish are read-only notifications: they
				// require content:read to register.
				capabilities: ["content:read"],
				hooks: {
					"content:afterDelete": { handler: afterDeleteHandler },
					"content:afterUnpublish": { handler: afterUnpublishHandler },
				},
			}),
		],
		createDialect: () => new SqliteDialect({ database: sqlite }),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};
}

/** Let any synchronous fire-and-forget microtasks settle. */
const drainMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Run everything the runtime handed to `after()`, like waitUntil would. */
async function flushDeferred(): Promise<void> {
	const tasks = deferred.splice(0);
	for (const task of tasks) await task();
}

describe("runtime defers lifecycle hooks through after()", () => {
	let runtime: EmDashRuntime;
	let repo: ContentRepository;

	beforeEach(async () => {
		deferred.length = 0;
		afterDeleteHandler.mockClear();
		afterUnpublishHandler.mockClear();

		const sqlite = new Database(":memory:");
		runtime = await EmDashRuntime.create(createDeps(sqlite));

		const registry = new SchemaRegistry(runtime.db);
		await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
		await registry.createField("post", { slug: "title", label: "Title", type: "string" });

		repo = new ContentRepository(runtime.db);

		// Drop any boot-time deferred work so each test observes only its own.
		deferred.length = 0;
	});

	afterEach(async () => {
		await runtime.stopCron();
	});

	it("schedules the afterDelete hook via after() on soft delete", async () => {
		const item = await repo.create({ type: "post", data: { title: "Doomed" } });

		deferred.length = 0;
		const result = await runtime.handleContentDelete("post", item.id);
		expect(result.success).toBe(true);

		// If the dispatch were fire-and-forget, the handler would have run by
		// now. Correct behavior defers it, so it has NOT run yet...
		await drainMicrotasks();
		expect(afterDeleteHandler).not.toHaveBeenCalled();
		expect(deferred.length).toBeGreaterThan(0);

		// ...and running what was handed to after() (as waitUntil would) fires it.
		await flushDeferred();
		expect(afterDeleteHandler).toHaveBeenCalledTimes(1);
	});

	it("schedules the afterUnpublish hook via after() on unpublish", async () => {
		const item = await repo.create({ type: "post", data: { title: "Live then gone" } });
		const published = await runtime.handleContentPublish("post", item.id);
		expect(published.success).toBe(true);

		// Clear the afterPublish deferral so we observe only the unpublish.
		deferred.length = 0;
		afterUnpublishHandler.mockClear();

		const result = await runtime.handleContentUnpublish("post", item.id);
		expect(result.success).toBe(true);

		await drainMicrotasks();
		expect(afterUnpublishHandler).not.toHaveBeenCalled();
		expect(deferred.length).toBeGreaterThan(0);

		await flushDeferred();
		expect(afterUnpublishHandler).toHaveBeenCalledTimes(1);
	});
});
