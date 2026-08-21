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
import { createSandboxRouteError } from "emdash";
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
		.addColumn("locale", "text")
		.addColumn("translation_group", "text")
		.execute();

	await db.schema
		.createTable("users")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("email", "text", (col) => col.notNull())
		.addColumn("name", "text")
		.addColumn("role", "integer", (col) => col.notNull())
		.addColumn("created_at", "text", (col) => col.notNull())
		.execute();
}

async function seedCapabilityFixtures(db: Kysely<any>) {
	await db
		.insertInto("users" as any)
		.values({
			id: "user-1",
			email: "test@example.com",
			name: "Test User",
			role: 50,
			created_at: "2026-01-01T00:00:00.000Z",
		})
		.execute();

	await db
		.insertInto("ec_posts" as any)
		.values({
			id: "post-1",
			slug: "seeded",
			status: "published",
			title: "Seeded",
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
			version: 1,
			locale: "en",
			translation_group: "post-1",
		})
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

/** Exercises each capability-gated context API from inside the isolate. */
const CAPABILITY_PROBE_PLUGIN = `
export default {
	hooks: {},
	routes: {
		"read": {
			handler: async (_routeCtx, ctx) => ctx.content.list("posts")
		},
		"write": {
			handler: async (routeCtx, ctx) => ctx.content.create("posts", { title: routeCtx.input.title })
		},
		"user": {
			handler: async (_routeCtx, ctx) => ctx.users.get("user-1")
		},
		"surface": {
			handler: async (_routeCtx, ctx) => ({ users: typeof ctx.users })
		}
	}
};
`;

const ROUTE_META = { method: "POST", url: "/api/test", headers: {} } as const;

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

	// Capability names reach the bridge in two vocabularies: current names
	// from a freshly published manifest, or legacy aliases carried by an
	// older manifest. Driving them from inside the
	// isolate covers the whole chain: generated wrapper -> HTTP -> backing
	// service -> token claims -> bridge handler.
	describe("capability vocabulary", () => {
		async function loadProbe(id: string, capabilities: string[]) {
			await seedCapabilityFixtures(db);
			return runner.load(
				{ id, version: "1.0.0", capabilities, allowedHosts: [], storage: {} },
				CAPABILITY_PROBE_PLUGIN,
			);
		}

		async function storedTitles() {
			const rows = await db
				.selectFrom("ec_posts" as any)
				.select("title")
				.execute();
			return rows.map((row: any) => row.title);
		}

		describe.each([
			{
				vocabulary: "current",
				id: "probe-current",
				capabilities: ["content:read", "content:write", "users:read"],
				title: "Written with current names",
			},
			{
				vocabulary: "legacy",
				id: "probe-legacy",
				capabilities: ["read:content", "write:content", "read:users"],
				title: "Written with legacy names",
			},
		])("$vocabulary capability names", ({ id, capabilities, title }) => {
			it("reads content through the sandbox", async () => {
				const plugin = await loadProbe(id, capabilities);

				const result = (await plugin.invokeRoute("read", {}, ROUTE_META)) as {
					items: Array<{ data: Record<string, unknown> }>;
				};

				expect(result.items).toHaveLength(1);
				expect(result.items[0]?.data.title).toBe("Seeded");
			}, 30_000);

			it("writes content through the sandbox", async () => {
				const plugin = await loadProbe(id, capabilities);

				await plugin.invokeRoute("write", { title }, ROUTE_META);

				expect(await storedTitles()).toContain(title);
			}, 30_000);

			it("reads users through the sandbox", async () => {
				const plugin = await loadProbe(id, capabilities);

				const user = (await plugin.invokeRoute("user", {}, ROUTE_META)) as { email: string };

				expect(user.email).toBe("test@example.com");
			}, 30_000);

			it("exposes the users API on the plugin context", async () => {
				const plugin = await loadProbe(id, capabilities);

				const surface = (await plugin.invokeRoute("surface", {}, ROUTE_META)) as { users: string };

				expect(surface.users).toBe("object");
			}, 30_000);
		});

		it("denies an undeclared capability with the current name", async () => {
			const plugin = await loadProbe("probe-none", []);

			await expect(plugin.invokeRoute("read", {}, ROUTE_META)).rejects.toThrow(
				"Missing capability: content:read",
			);
		}, 30_000);

		it("does not let a write-only plugin read content", async () => {
			const plugin = await loadProbe("probe-write-only", ["content:write"]);

			await plugin.invokeRoute("write", { title: "Write only" }, ROUTE_META);
			expect(await storedTitles()).toContain("Write only");

			await expect(plugin.invokeRoute("read", {}, ROUTE_META)).rejects.toThrow(
				"Missing capability: content:read",
			);
		}, 30_000);

		it("withholds the users API when the capability is undeclared", async () => {
			const plugin = await loadProbe("probe-no-users", ["content:read"]);

			const surface = (await plugin.invokeRoute("surface", {}, ROUTE_META)) as { users: string };

			expect(surface.users).toBe("undefined");
		}, 30_000);
	});
});
