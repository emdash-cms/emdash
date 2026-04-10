/**
 * Bridge Handler Conformance Tests
 *
 * Tests the shared bridge handler that both the production (workerd)
 * and dev (miniflare) runners use. This is the conformance test suite
 * that ensures identical behavior across all sandbox runners.
 *
 * These tests exercise capability enforcement, KV isolation, and
 * error handling at the bridge level.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createBridgeHandler } from "../src/sandbox/bridge-handler.js";

// Set up an in-memory SQLite database with the minimum tables needed
function createTestDb() {
	const sqlite = new Database(":memory:");
	const db = new Kysely<any>({
		dialect: new SqliteDialect({ database: sqlite }),
	});
	return { db, sqlite };
}

async function setupTables(db: Kysely<any>) {
	// Plugin storage table (used for both KV and document storage)
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

	// Users table (matches migration 001)
	await db.schema
		.createTable("users")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("email", "text", (col) => col.notNull())
		.addColumn("name", "text")
		.addColumn("role", "integer", (col) => col.notNull())
		.addColumn("created_at", "text", (col) => col.notNull())
		.execute();

	// Insert a test user
	await db
		.insertInto("users" as any)
		.values({
			id: "user-1",
			email: "test@example.com",
			name: "Test User",
			role: 50,
			created_at: new Date().toISOString(),
		})
		.execute();
}

describe("Bridge Handler Conformance", () => {
	let db: Kysely<any>;
	let sqlite: Database.Database;

	beforeEach(async () => {
		const ctx = createTestDb();
		db = ctx.db;
		sqlite = ctx.sqlite;
		await setupTables(db);
	});

	afterEach(async () => {
		await db.destroy();
		sqlite.close();
	});

	function makeHandler(opts: {
		capabilities?: string[];
		allowedHosts?: string[];
		storageCollections?: string[];
	}) {
		return createBridgeHandler({
			pluginId: "test-plugin",
			version: "1.0.0",
			capabilities: opts.capabilities ?? [],
			allowedHosts: opts.allowedHosts ?? [],
			storageCollections: opts.storageCollections ?? [],
			db,
			emailSend: () => null,
		});
	}

	async function call(
		handler: ReturnType<typeof makeHandler>,
		method: string,
		body: Record<string, unknown> = {},
	) {
		const request = new Request(`http://bridge/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const response = await handler(request);
		return response.json() as Promise<{ result?: unknown; error?: string }>;
	}

	// ── KV Operations ────────────────────────────────────────────────────

	describe("KV operations", () => {
		it("set and get a value", async () => {
			const handler = makeHandler({});
			await call(handler, "kv/set", { key: "test", value: "hello" });
			const result = await call(handler, "kv/get", { key: "test" });
			expect(result.result).toBe("hello");
		});

		it("get returns null for non-existent key", async () => {
			const handler = makeHandler({});
			const result = await call(handler, "kv/get", { key: "missing" });
			expect(result.result).toBeNull();
		});

		it("delete removes a key", async () => {
			const handler = makeHandler({});
			await call(handler, "kv/set", { key: "to-delete", value: "bye" });
			await call(handler, "kv/delete", { key: "to-delete" });
			const result = await call(handler, "kv/get", { key: "to-delete" });
			expect(result.result).toBeNull();
		});

		it("list returns keys with prefix", async () => {
			const handler = makeHandler({});
			await call(handler, "kv/set", { key: "settings:theme", value: "dark" });
			await call(handler, "kv/set", { key: "settings:lang", value: "en" });
			await call(handler, "kv/set", { key: "state:count", value: 42 });

			const result = await call(handler, "kv/list", { prefix: "settings:" });
			const items = result.result as Array<{ key: string; value: unknown }>;
			expect(items).toHaveLength(2);
			expect(items.map((i) => i.key).toSorted()).toEqual(["settings:lang", "settings:theme"]);
		});

		it("KV is scoped per plugin (isolation)", async () => {
			const handlerA = createBridgeHandler({
				pluginId: "plugin-a",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storageCollections: [],
				db,
				emailSend: () => null,
			});
			const handlerB = createBridgeHandler({
				pluginId: "plugin-b",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storageCollections: [],
				db,
				emailSend: () => null,
			});

			// Plugin A sets a value
			await call(handlerA, "kv/set", { key: "secret", value: "a-data" });

			// Plugin B cannot see it
			const resultB = await call(handlerB, "kv/get", { key: "secret" });
			expect(resultB.result).toBeNull();

			// Plugin A can see it
			const resultA = await call(handlerA, "kv/get", { key: "secret" });
			expect(resultA.result).toBe("a-data");
		});
	});

	// ── Capability Enforcement ────────────────────────────────────────────

	describe("capability enforcement", () => {
		it("rejects content read without read:content capability", async () => {
			const handler = makeHandler({ capabilities: [] });
			const result = await call(handler, "content/get", {
				collection: "posts",
				id: "123",
			});
			expect(result.error).toContain("Missing capability: read:content");
		});

		it("allows content read with read:content", async () => {
			// Create a content table first
			await db.schema
				.createTable("ec_posts")
				.addColumn("id", "text", (col) => col.primaryKey())
				.addColumn("deleted_at", "text")
				.addColumn("title", "text")
				.execute();

			const handler = makeHandler({ capabilities: ["read:content"] });
			const result = await call(handler, "content/get", {
				collection: "posts",
				id: "123",
			});
			// No error, returns null (post doesn't exist)
			expect(result.error).toBeUndefined();
			expect(result.result).toBeNull();
		});

		it("write:content does NOT imply read:content (matches Cloudflare bridge)", async () => {
			// The bridge enforces capabilities strictly: a plugin that declares
			// only write:content cannot call ctx.content.get/list. This matches
			// the Cloudflare PluginBridge behavior. The plugin must declare
			// read:content explicitly to read.
			await db.schema
				.createTable("ec_posts")
				.addColumn("id", "text", (col) => col.primaryKey())
				.addColumn("deleted_at", "text")
				.addColumn("title", "text")
				.execute();

			const handler = makeHandler({ capabilities: ["write:content"] });
			const result = await call(handler, "content/get", {
				collection: "posts",
				id: "123",
			});
			expect(result.error).toContain("Missing capability: read:content");
		});

		it("rejects user read without read:users capability", async () => {
			const handler = makeHandler({ capabilities: [] });
			const result = await call(handler, "users/get", { id: "user-1" });
			expect(result.error).toContain("Missing capability: read:users");
		});

		it("allows user read with read:users", async () => {
			const handler = makeHandler({ capabilities: ["read:users"] });
			const result = await call(handler, "users/get", { id: "user-1" });
			expect(result.error).toBeUndefined();
			const user = result.result as { id: string; email: string };
			expect(user.id).toBe("user-1");
			expect(user.email).toBe("test@example.com");
		});

		it("rejects network fetch without network:fetch capability", async () => {
			const handler = makeHandler({ capabilities: [] });
			const result = await call(handler, "http/fetch", {
				url: "https://example.com",
			});
			expect(result.error).toContain("Missing capability: network:fetch");
		});

		it("rejects email send without email:send capability", async () => {
			const handler = makeHandler({ capabilities: [] });
			const result = await call(handler, "email/send", {
				message: { to: "a@b.com", subject: "hi", text: "hello" },
			});
			expect(result.error).toContain("Missing capability: email:send");
		});
	});

	// ── Storage (document store) ──────────────────────────────────────────

	describe("plugin storage", () => {
		it("rejects access to undeclared storage collection", async () => {
			const handler = makeHandler({ storageCollections: ["logs"] });
			const result = await call(handler, "storage/get", {
				collection: "secrets",
				id: "1",
			});
			expect(result.error).toContain("Storage collection not declared: secrets");
		});

		it("allows access to declared storage collection", async () => {
			const handler = makeHandler({ storageCollections: ["logs"] });
			const result = await call(handler, "storage/get", {
				collection: "logs",
				id: "1",
			});
			expect(result.error).toBeUndefined();
			expect(result.result).toBeNull();
		});

		it("put and get storage document", async () => {
			const handler = makeHandler({ storageCollections: ["logs"] });
			await call(handler, "storage/put", {
				collection: "logs",
				id: "log-1",
				data: { message: "hello", level: "info" },
			});
			const result = await call(handler, "storage/get", {
				collection: "logs",
				id: "log-1",
			});
			expect(result.result).toEqual({ message: "hello", level: "info" });
		});

		it("storage is scoped per plugin", async () => {
			const handlerA = createBridgeHandler({
				pluginId: "plugin-a",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storageCollections: ["data"],
				db,
				emailSend: () => null,
			});
			const handlerB = createBridgeHandler({
				pluginId: "plugin-b",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storageCollections: ["data"],
				db,
				emailSend: () => null,
			});

			await call(handlerA, "storage/put", {
				collection: "data",
				id: "item-1",
				data: { owner: "a" },
			});

			// Plugin B cannot see plugin A's data
			const resultB = await call(handlerB, "storage/get", {
				collection: "data",
				id: "item-1",
			});
			expect(resultB.result).toBeNull();
		});
	});

	// ── Error Handling ────────────────────────────────────────────────────

	describe("error handling", () => {
		it("returns error for unknown bridge method", async () => {
			const handler = makeHandler({});
			const result = await call(handler, "unknown/method");
			expect(result.error).toContain("Unknown bridge method: unknown/method");
		});

		it("returns error for missing required parameters", async () => {
			const handler = makeHandler({ capabilities: ["read:content"] });
			const result = await call(handler, "content/get", {});
			expect(result.error).toContain("Missing required string parameter");
		});
	});

	// ── Logging ───────────────────────────────────────────────────────────

	describe("logging", () => {
		it("log call succeeds without capabilities", async () => {
			const handler = makeHandler({});
			const result = await call(handler, "log", {
				level: "info",
				msg: "test message",
			});
			expect(result.error).toBeUndefined();
			expect(result.result).toBeNull();
		});
	});
});
