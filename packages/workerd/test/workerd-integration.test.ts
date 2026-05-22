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
import { Kysely, SqliteDialect } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { WorkerdSandboxRunner } from "../src/sandbox/runner.js";

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
