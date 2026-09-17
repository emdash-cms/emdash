/**
 * Workerd Integration Tests
 *
 * These tests spawn a real workerd process and exercise the full plugin
 * lifecycle: load, invoke hooks/routes, unload, and error handling.
 *
 * Skipped if the workerd binary is not available (e.g., in CI without
 * the workerd package installed).
 */

import Database from "better-sqlite3";
import { createSandboxRouteError, SchemaRegistry } from "emdash";
import type { RuntimeDependencies } from "emdash/plugin-test-runtime";
import { Kysely, SqliteDialect, type QueryId } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { WorkerdSandboxRunner } from "../src/sandbox/runner.js";

vi.mock("virtual:emdash/config", () => ({ default: null }), { virtual: true });
vi.mock("virtual:emdash/object-cache", () => ({ default: null }), { virtual: true });

// Check at module level so describe.skipIf works
let workerdAvailable = false;
try {
	const testRunner = new WorkerdSandboxRunner({ db: null as any });
	workerdAvailable = testRunner.isAvailable();
} catch {
	// workerd not available
}

function createTestDb() {
	const sqlite = new Database(":memory:");
	const db = new Kysely<any>({
		dialect: new SqliteDialect({ database: sqlite }),
	});
	return { db, sqlite };
}

async function setupTables(db: Kysely<any>) {
	await db.schema
		.createTable("_plugin_storage")
		.addColumn("plugin_id", "text", (col) => col.notNull())
		.addColumn("collection", "text", (col) => col.notNull())
		.addColumn("id", "text", (col) => col.notNull())
		.addColumn("data", "text", (col) => col.notNull())
		.addColumn("revision", "text", (col) => col.notNull().defaultTo("0"))
		.addColumn("created_at", "text", (col) => col.notNull())
		.addColumn("updated_at", "text", (col) => col.notNull())
		.addPrimaryKeyConstraint("pk_plugin_storage", ["plugin_id", "collection", "id"])
		.execute();

	await db.schema
		.createTable("ec_posts")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("slug", "text")
		.addColumn("status", "text", (col) => col.defaultTo("draft"))
		.addColumn("title", "text")
		.addColumn("author_id", "text")
		.addColumn("created_at", "text")
		.addColumn("updated_at", "text")
		.addColumn("published_at", "text")
		.addColumn("scheduled_at", "text")
		.addColumn("deleted_at", "text")
		.addColumn("version", "integer", (col) => col.defaultTo(1))
		.addColumn("live_revision_id", "text")
		.addColumn("draft_revision_id", "text")
		.execute();

	await db.schema
		.createTable("_emdash_cron_tasks")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("plugin_id", "text", (col) => col.notNull())
		.addColumn("task_name", "text", (col) => col.notNull())
		.addColumn("schedule", "text", (col) => col.notNull())
		.addColumn("is_oneshot", "integer", (col) => col.notNull())
		.addColumn("data", "text")
		.addColumn("next_run_at", "text", (col) => col.notNull())
		.addColumn("last_run_at", "text")
		.addColumn("status", "text", (col) => col.notNull())
		.addColumn("locked_at", "text")
		.addColumn("enabled", "integer", (col) => col.notNull())
		.addUniqueConstraint("uq_cron_plugin_task", ["plugin_id", "task_name"])
		.execute();
}

/** Minimal plugin code that echoes back hook/route calls.
 * Route handlers receive { input, request, requestMeta } as first arg. */
const ECHO_PLUGIN = `
export default {
	hooks: {
		"content:beforeSave": {
			handler: async (event, ctx) => {
				await ctx.kv.set("last-hook", JSON.stringify({ hook: "content:beforeSave", event }));
				return event;
			}
		}
	},
	routes: {
		"echo": {
			handler: async (routeCtx, ctx) => {
				const kvValue = await ctx.kv.get("last-hook");
				return { input: routeCtx.input, kvValue };
			}
		},
		"kv-test": {
			handler: async (routeCtx, ctx) => {
				await ctx.kv.set("test-key", routeCtx.input.value);
				const result = await ctx.kv.get("test-key");
				return { stored: result };
			}
		},
		"cron-test": {
			handler: async (_routeCtx, ctx) => {
				await ctx.cron.schedule("daily", { schedule: "@daily", data: { source: "workerd" } });
				return ctx.cron.list();
			}
		},
		"conditional-test": {
			handler: async (_routeCtx, ctx) => {
				const results = [];
				for (const store of [ctx.kv, ctx.storage.records]) {
					const created = await store.compareAndSet("__proto__", null, null);
					const saved = await store.getVersioned("__proto__");
					const conflict = await store.compareAndSet("__proto__", null, "overwrite");
					const updated = await store.compareAndSet("__proto__", saved.revision, { status: "ready" });
					const staleDelete = await store.compareAndDelete("__proto__", saved.revision);
					const deleted = await store.compareAndDelete("__proto__", updated.revision);
					results.push({ created, saved, conflict, updated, staleDelete, deleted, missing: await store.getVersioned("__proto__") });
				}
				return results;
			}
		}
	}
};
`;

const UPDATE_IF_PLUGIN = `
export default {
	routes: {
		reserve: {
			handler: async (_routeCtx, ctx) => {
				const store = ctx.storage.records;
				await store.put("stock", { stock: 2, title: "retained" });
				const outcomes = await Promise.all(Array.from({ length: 4 }, () =>
					store.updateIf("stock", { where: { stock: { gte: 1 } }, delta: { stock: { dec: 1 } } })
				));
				return { outcomes, saved: await store.get("stock") };
			}
		},
		retry: {
			handler: async (_routeCtx, ctx) => {
				try {
					await ctx.storage.records.updateIf("stock", { where: {}, set: { stock: 1 } });
					return { unexpectedSuccess: true };
				} catch (error) {
					return {
						name: error.name, code: error.code, retryable: error.retryable,
						sqlState: error.sqlState, message: error.message, hasCause: "cause" in error
					};
				}
			}
		}
	}
};
`;

/** Plugin that sleeps longer than the wall-time limit */
const SLOW_PLUGIN = `
export default {
	hooks: {},
	routes: {
		"slow": {
			handler: async () => {
				await new Promise(r => setTimeout(r, 60000));
				return { done: true };
			}
		}
	}
};
`;

const CONTENT_WRITE_PLUGIN = `
export default {
	hooks: {},
	routes: {
		"write": {
			handler: async (_routeCtx, ctx) => ctx.content.create("posts", { slug: "blocked" })
		}
	}
};
`;

const BINARY_HTTP_PLUGIN = `
export default {
	hooks: {},
	routes: {
		"roundtrip": {
			handler: async (route, ctx) => {
				const response = await ctx.http.fetch(route.input.url, {
					method: "POST",
					headers: { "content-type": "application/octet-stream" },
					body: new Uint8Array([0, 255, 195, 40])
				});
				const clone = response.clone();
				return {
					status: response.status,
					statusText: response.statusText,
					url: response.url,
					redirected: response.redirected,
					bytes: [...new Uint8Array(await response.arrayBuffer())],
					cloneBytes: [...new Uint8Array(await clone.arrayBuffer())]
				};
			}
		}
	}
};
`;

const SAVE_REJECTION_PLUGIN = `
export default {
	hooks: {
		"content:beforeSave": async () => ({
			__emdashSandboxHookResult: true,
			version: 1,
			error: { code: "SAVE_REJECTED", reason: "Add a summary" }
		})
	}
};
`;

const RUNTIME_HOST_PLUGIN = `
let isolateId;
export default {
	hooks: {
		"content:beforeSave": async (event, ctx) => {
			await ctx.kv.set("saw-save", true);
			return { ...event.content, title: event.content.title + " [workerd]" };
		}
	},
	routes: {
		"state": {
			handler: async (_route, ctx) => ({ isolateId: isolateId ??= crypto.randomUUID(), sawSave: await ctx.kv.get("saw-save") })
		}
	}
};
`;

describe.skipIf(!workerdAvailable)("WorkerdSandboxRunner integration", () => {
	let db: Kysely<any>;
	let sqlite: Database.Database;
	let runner: WorkerdSandboxRunner;

	beforeEach(async () => {
		const testDb = createTestDb();
		db = testDb.db;
		sqlite = testDb.sqlite;
		await setupTables(db);

		runner = new WorkerdSandboxRunner({ db });
	});

	afterEach(async () => {
		await runner.terminateAll();
		await db.destroy();
		sqlite.close();
	});

	it("loads a plugin and invokes a route", async () => {
		const plugin = await runner.load(
			{
				id: "test-echo",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
			},
			ECHO_PLUGIN,
		);

		const result = (await plugin.invokeRoute(
			"echo",
			{ hello: "world" },
			{
				method: "POST",
				url: "/api/test",
				headers: {},
			},
		)) as any;

		expect(result).toBeDefined();
		expect(result.input).toEqual({ hello: "world" });
	}, 30_000);

	it("preserves concurrent binary HTTP through the real workerd bridge", async () => {
		await runner.terminateAll();
		const requests: Array<{ url: string; body: Uint8Array }> = [];
		runner = new WorkerdSandboxRunner({
			db,
			httpFetch: async (input, init) => {
				const request = new Request(input, init);
				requests.push({
					url: request.url,
					body: new Uint8Array(await request.arrayBuffer()),
				});
				const second = request.url.endsWith("/second");
				return new Response(
					second ? new Uint8Array([137, 80, 78, 71]) : new Uint8Array([0, 255, 195, 40]),
					{
						status: second ? 200 : 206,
						statusText: second ? "OK" : "Partial Content",
						headers: { "content-type": "application/octet-stream" },
					},
				);
			},
		});
		const plugin = await runner.load(
			{
				id: "binary-http",
				version: "1.0.0",
				capabilities: ["network:request"],
				allowedHosts: ["93.184.216.34"],
				storage: {},
			},
			BINARY_HTTP_PLUGIN,
		);
		const urls = ["https://93.184.216.34/first", "https://93.184.216.34/second"];
		const results = await Promise.all(
			urls.map((url) =>
				plugin.invokeRoute(
					"roundtrip",
					{ url },
					{ method: "POST", url: "/api/roundtrip", headers: {} },
				),
			),
		);

		expect(results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					status: 206,
					statusText: "Partial Content",
					url: urls[0],
					bytes: [0, 255, 195, 40],
					cloneBytes: [0, 255, 195, 40],
				}),
				expect.objectContaining({
					status: 200,
					url: urls[1],
					bytes: [137, 80, 78, 71],
					cloneBytes: [137, 80, 78, 71],
				}),
			]),
		);
		expect(requests).toEqual(
			expect.arrayContaining(urls.map((url) => ({ url, body: new Uint8Array([0, 255, 195, 40]) }))),
		);
	}, 30_000);

	it("drops cached network authority when a plugin version is replaced", async () => {
		await runner.terminateAll();
		const httpFetch = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(new Uint8Array([0, 255]), {
				status: 206,
				statusText: "Partial Content",
				headers: { "content-type": "application/octet-stream" },
			}),
		);
		runner = new WorkerdSandboxRunner({ db, httpFetch });
		const unrestricted = await runner.load(
			{
				id: "authority-update",
				version: "1.0.0",
				capabilities: ["network:request:unrestricted"],
				allowedHosts: [],
				storage: {},
			},
			BINARY_HTTP_PLUGIN,
		);
		await expect(
			unrestricted.invokeRoute(
				"roundtrip",
				{ url: "https://93.184.216.34/first" },
				{ method: "POST", url: "/api/roundtrip", headers: {} },
			),
		).resolves.toMatchObject({ status: 206 });
		await unrestricted.terminate();

		const restricted = await runner.load(
			{
				id: "authority-update",
				version: "2.0.0",
				capabilities: ["network:request"],
				allowedHosts: ["api.example.com"],
				storage: {},
			},
			BINARY_HTTP_PLUGIN,
		);
		await expect(
			restricted.invokeRoute(
				"roundtrip",
				{ url: "https://93.184.216.34/second" },
				{ method: "POST", url: "/api/roundtrip", headers: {} },
			),
		).rejects.toThrow(/not allowed to fetch from host/i);
		expect(httpFetch).toHaveBeenCalledOnce();
	}, 30_000);

	it("runs an equivalent runtime content and cold-restart journey through workerd", async () => {
		const { EmDashRuntime } = await import("emdash/plugin-test-runtime");
		const runtimeSqlite = new Database(":memory:");
		const deps: RuntimeDependencies = {
			config: {
				database: {
					entrypoint: `workerd-runtime-${crypto.randomUUID()}`,
					type: "sqlite",
					config: {},
				},
			},
			plugins: [],
			createDialect: () => new SqliteDialect({ database: runtimeSqlite }),
			createStorage: null,
			createScheduler: null,
			sandboxEnabled: true,
			sandboxedPluginEntries: [
				{
					id: "runtime-workerd",
					version: "1.0.0",
					options: {},
					code: RUNTIME_HOST_PLUGIN,
					capabilities: ["content:write"],
					allowedHosts: [],
					storage: {},
					hooks: ["content:beforeSave"],
					routes: [{ name: "state", public: true }],
				},
			],
			createSandboxRunner: (options) => new WorkerdSandboxRunner(options),
		};
		let runtime = await EmDashRuntime.create(deps);
		try {
			await new SchemaRegistry(runtime.db).createCollection({ slug: "posts", label: "Posts" });
			await new SchemaRegistry(runtime.db).createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});
			const created = await runtime.handleContentCreate("posts", { data: { title: "Original" } });
			expect(created).toMatchObject({
				success: true,
				data: { item: { data: { title: "Original [workerd]" } } },
			});
			if (!created.success) return;
			const first = await runtime.handlePluginApiRoute(
				"runtime-workerd",
				"GET",
				"/state",
				new Request("https://test.local/state"),
			);
			await runtime.shutdown();
			runtime = await EmDashRuntime.create(deps);
			const second = await runtime.handlePluginApiRoute(
				"runtime-workerd",
				"GET",
				"/state",
				new Request("https://test.local/state"),
			);
			expect(second).toMatchObject({ success: true, data: { sawSave: true } });
			expect(second.success && first.success && second.data.isolateId).not.toBe(
				first.success ? first.data.isolateId : undefined,
			);
		} finally {
			await runtime.shutdown();
			await runtime.db.destroy();
			runtimeSqlite.close();
		}
	}, 30_000);

	it("loads a plugin and invokes a hook", async () => {
		const plugin = await runner.load(
			{
				id: "test-echo",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
			},
			ECHO_PLUGIN,
		);

		const result = await plugin.invokeHook("content:beforeSave", {
			content: { title: "Test" },
		});

		expect(result).toBeDefined();

		// Verify KV was written via the hook
		const kvResult = (await plugin.invokeRoute(
			"echo",
			{},
			{
				method: "GET",
				url: "/api/test",
				headers: {},
			},
		)) as any;

		expect(kvResult.kvValue).toBeTruthy();
		const parsed = JSON.parse(kvResult.kvValue);
		expect(parsed.hook).toBe("content:beforeSave");
	}, 30_000);

	it("preserves a versioned hook error result over the workerd HTTP transport", async () => {
		const plugin = await runner.load(
			{
				id: "test-save-rejection",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
			},
			SAVE_REJECTION_PLUGIN,
		);

		await expect(plugin.invokeHook("content:beforeSave", {})).resolves.toEqual({
			__emdashSandboxHookResult: true,
			version: 1,
			error: { code: "SAVE_REJECTED", reason: "Add a summary" },
		});
	}, 30_000);

	it("enforces KV isolation between plugins via routes", async () => {
		const plugin = await runner.load(
			{
				id: "test-kv",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
			},
			ECHO_PLUGIN,
		);

		const result = (await plugin.invokeRoute(
			"kv-test",
			{ value: "hello" },
			{
				method: "POST",
				url: "/api/test",
				headers: {},
			},
		)) as any;

		expect(result.stored).toBe("hello");
	}, 30_000);

	it("provides plugin-scoped cron through the production workerd bridge", async () => {
		const plugin = await runner.load(
			{
				id: "test-cron",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
			},
			ECHO_PLUGIN,
		);

		await expect(
			plugin.invokeRoute("cron-test", {}, { method: "POST", url: "/api/cron", headers: {} }),
		).resolves.toEqual([expect.objectContaining({ name: "daily", schedule: "@daily" })]);
		expect(
			await db
				.selectFrom("_emdash_cron_tasks" as any)
				.select("plugin_id" as any)
				.executeTakeFirst(),
		).toMatchObject({ plugin_id: "test-cron" });
	}, 30_000);

	it("preserves versioned values and conditional results through the generated worker", async () => {
		const plugin = await runner.load(
			{
				id: "test-conditional",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: { records: { indexes: [] } },
			},
			ECHO_PLUGIN,
		);
		const result = await plugin.invokeRoute(
			"conditional-test",
			{},
			{
				method: "POST",
				url: "/api/conditional",
				headers: {},
			},
		);
		expect(result).toEqual(
			[0, 1].map(() => ({
				created: { applied: true, revision: expect.any(String) },
				saved: { value: null, revision: expect.any(String) },
				conflict: { applied: false },
				updated: { applied: true, revision: expect.any(String) },
				staleDelete: { applied: false },
				deleted: { applied: true },
				missing: null,
			})),
		);
	}, 30_000);

	it("runs guarded decrements through the generated worker", async () => {
		const plugin = await runner.load(
			{
				id: "test-update-if",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: { records: { indexes: ["stock"] } },
			},
			UPDATE_IF_PLUGIN,
		);
		const result = await plugin.invokeRoute(
			"reserve",
			{},
			{
				method: "POST",
				url: "/api/reserve",
				headers: {},
			},
		);
		expect(result).toEqual({
			outcomes: expect.arrayContaining([
				{ applied: true, data: { stock: 1, title: "retained" } },
				{ applied: true, data: { stock: 0, title: "retained" } },
				{ applied: false },
				{ applied: false },
			]),
			saved: { stock: 0, title: "retained" },
		});
	}, 30_000);

	it("reconstructs safe storage retry metadata through the generated worker", async () => {
		const updates = new WeakSet<QueryId>();
		runner = new WorkerdSandboxRunner({
			db: db.withPlugin({
				transformQuery: ({ node, queryId }) => {
					if (node.kind === "UpdateQueryNode") updates.add(queryId);
					return node;
				},
				transformResult: async ({ result, queryId }) => {
					if (updates.has(queryId)) {
						throw Object.assign(new Error("private SQL and parameters"), { code: "40P01" });
					}
					return result;
				},
			}),
		});
		const plugin = await runner.load(
			{
				id: "test-update-retry",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: { records: { indexes: [] } },
			},
			UPDATE_IF_PLUGIN,
		);
		expect(
			await plugin.invokeRoute(
				"retry",
				{},
				{
					method: "POST",
					url: "/api/retry",
					headers: {},
				},
			),
		).toEqual({
			name: "StorageSerializationError",
			code: "STORAGE_SERIALIZATION_FAILURE",
			retryable: true,
			sqlState: "40P01",
			hasCause: false,
			message:
				"Storage write must be retried. Restart the transaction before retrying when using an explicit transaction.",
		});
	}, 30_000);

	it("handles plugin unload and reload", async () => {
		const plugin1 = await runner.load(
			{
				id: "test-reload",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
			},
			ECHO_PLUGIN,
		);

		// Invoke to verify it works
		const result1 = (await plugin1.invokeRoute(
			"echo",
			{ v: 1 },
			{
				method: "POST",
				url: "/api/test",
				headers: {},
			},
		)) as any;
		expect(result1.input.v).toBe(1);

		// Unload
		await plugin1.terminate();

		// Reload with new version
		const plugin2 = await runner.load(
			{
				id: "test-reload",
				version: "2.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
			},
			ECHO_PLUGIN,
		);

		const result2 = (await plugin2.invokeRoute(
			"echo",
			{ v: 2 },
			{
				method: "POST",
				url: "/api/test",
				headers: {},
			},
		)) as any;
		expect(result2.input.v).toBe(2);
	}, 60_000);

	it("enforces wall-time limit", async () => {
		const slowRunner = new WorkerdSandboxRunner({
			db,
			limits: { wallTimeMs: 2000 },
		});

		try {
			const plugin = await slowRunner.load(
				{
					id: "test-slow",
					version: "1.0.0",
					capabilities: [],
					allowedHosts: [],
					storage: {},
				},
				SLOW_PLUGIN,
			);

			await expect(
				plugin.invokeRoute(
					"slow",
					{},
					{
						method: "POST",
						url: "/api/test",
						headers: {},
					},
				),
			).rejects.toThrow(/exceeded wall-time limit/);
		} finally {
			await slowRunner.terminateAll();
		}
	}, 30_000);

	it("preserves a content-write fence through the sandbox route transport", async () => {
		const fencedRunner = new WorkerdSandboxRunner({
			db,
			beforeContentWrite: async () => {
				throw createSandboxRouteError("MEDIA_USAGE_ACTIVATION_IN_PROGRESS");
			},
		});

		try {
			const plugin = await fencedRunner.load(
				{
					id: "test-content-write",
					version: "1.0.0",
					capabilities: ["content:write"],
					allowedHosts: [],
					storage: {},
				},
				CONTENT_WRITE_PLUGIN,
			);

			await expect(
				plugin.invokeRoute(
					"write",
					{},
					{
						method: "POST",
						url: "/api/test",
						headers: {},
					},
				),
			).rejects.toMatchObject({
				code: "MEDIA_USAGE_ACTIVATION_IN_PROGRESS",
				message: "Media usage activation is in progress",
				status: 503,
			});
		} finally {
			await fencedRunner.terminateAll();
		}
	}, 30_000);

	it("loads multiple plugins simultaneously", async () => {
		const plugin1 = await runner.load(
			{
				id: "test-multi-a",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
			},
			ECHO_PLUGIN,
		);

		const plugin2 = await runner.load(
			{
				id: "test-multi-b",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
			},
			ECHO_PLUGIN,
		);

		const [r1, r2] = (await Promise.all([
			plugin1.invokeRoute(
				"echo",
				{ from: "a" },
				{
					method: "POST",
					url: "/api/test",
					headers: {},
				},
			),
			plugin2.invokeRoute(
				"echo",
				{ from: "b" },
				{
					method: "POST",
					url: "/api/test",
					headers: {},
				},
			),
		])) as any[];

		expect(r1.input.from).toBe("a");
		expect(r2.input.from).toBe("b");
	}, 30_000);
});
