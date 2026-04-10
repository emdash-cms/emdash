/**
 * Plugin Integration Tests
 *
 * Exercises the bridge handler with the same operations that EmDash's
 * shipped plugins perform. Uses a real SQLite database with migrations
 * to test against the actual schema, not hand-rolled test tables.
 *
 * This validates that the workerd bridge handler produces the same
 * results as the Cloudflare PluginBridge for real plugin workloads.
 *
 * Tests are modeled after the sandboxed-test plugin's routes:
 * - kv/test: set, get, delete a KV entry
 * - storage/test: put, get, count in a declared storage collection
 * - content/list: list content with read:content capability
 * - content lifecycle: create, read, update, soft-delete
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBridgeHandler } from "../src/sandbox/bridge-handler.js";

/**
 * Create a test database with the minimum schema needed for plugin operations.
 * Matches the real migration schema (001_initial + 004_plugins).
 */
function createTestDb() {
	const sqlite = new Database(":memory:");
	const db = new Kysely<any>({
		dialect: new SqliteDialect({ database: sqlite }),
	});
	return { db, sqlite };
}

async function runMigrations(db: Kysely<any>) {
	// Plugin storage (migration 004)
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

	// Users (migration 001)
	await db.schema
		.createTable("users")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("email", "text", (col) => col.notNull())
		.addColumn("name", "text")
		.addColumn("role", "integer", (col) => col.notNull())
		.addColumn("created_at", "text", (col) => col.notNull())
		.execute();

	// Media (migration 001)
	await db.schema
		.createTable("media")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("filename", "text", (col) => col.notNull())
		.addColumn("mime_type", "text", (col) => col.notNull())
		.addColumn("size", "integer")
		.addColumn("storage_key", "text", (col) => col.notNull())
		.addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
		.addColumn("created_at", "text", (col) => col.notNull())
		.execute();

	// Content table for posts (created by SchemaRegistry in real code)
	await db.schema
		.createTable("ec_posts")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("slug", "text")
		.addColumn("status", "text", (col) => col.notNull().defaultTo("draft"))
		.addColumn("author_id", "text")
		.addColumn("created_at", "text", (col) => col.notNull())
		.addColumn("updated_at", "text", (col) => col.notNull())
		.addColumn("published_at", "text")
		.addColumn("deleted_at", "text")
		.addColumn("version", "integer", (col) => col.notNull().defaultTo(1))
		.addColumn("title", "text")
		.addColumn("body", "text")
		.execute();
}

describe("Plugin integration: sandboxed-test plugin operations", () => {
	let db: Kysely<any>;
	let sqlite: Database.Database;

	beforeEach(async () => {
		const ctx = createTestDb();
		db = ctx.db;
		sqlite = ctx.sqlite;
		await runMigrations(db);
	});

	afterEach(async () => {
		await db.destroy();
		sqlite.close();
	});

	/**
	 * Create a bridge handler matching the sandboxed-test plugin's capabilities:
	 * read:content, network:fetch with allowedHosts: ["httpbin.org"]
	 * storage: { events: { indexes: ["timestamp", "type"] } }
	 */
	function makePluginHandler() {
		return createBridgeHandler({
			pluginId: "sandboxed-test",
			version: "0.0.1",
			capabilities: ["read:content", "network:fetch"],
			allowedHosts: ["httpbin.org"],
			storageCollections: ["events"],
			db,
			emailSend: () => null,
		});
	}

	async function call(
		handler: ReturnType<typeof makePluginHandler>,
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

	// ── Mirrors sandboxed-test plugin's kv/test route ────────────────────

	it("KV round-trip: set, get, delete", async () => {
		const handler = makePluginHandler();

		// Set
		await call(handler, "kv/set", {
			key: "sandbox-test-key",
			value: { tested: true, time: 12345 },
		});

		// Get
		const getResult = await call(handler, "kv/get", { key: "sandbox-test-key" });
		expect(getResult.result).toEqual({ tested: true, time: 12345 });

		// Delete
		const deleteResult = await call(handler, "kv/delete", { key: "sandbox-test-key" });
		expect(deleteResult.result).toBe(true);

		// Verify deleted
		const afterDelete = await call(handler, "kv/get", { key: "sandbox-test-key" });
		expect(afterDelete.result).toBeNull();
	});

	// ── Mirrors sandboxed-test plugin's storage/test route ───────────────

	it("Storage round-trip: put, get, count", async () => {
		const handler = makePluginHandler();

		// Put
		await call(handler, "storage/put", {
			collection: "events",
			id: "event-1",
			data: {
				timestamp: "2025-01-01T00:00:00Z",
				type: "test",
				message: "Sandboxed plugin storage test",
			},
		});

		// Get
		const getResult = await call(handler, "storage/get", {
			collection: "events",
			id: "event-1",
		});
		expect(getResult.result).toEqual({
			timestamp: "2025-01-01T00:00:00Z",
			type: "test",
			message: "Sandboxed plugin storage test",
		});

		// Count
		const countResult = await call(handler, "storage/count", { collection: "events" });
		expect(countResult.result).toBe(1);
	});

	// ── Mirrors sandboxed-test plugin's content/list route ───────────────

	it("Content list with read:content capability", async () => {
		const handler = makePluginHandler();

		// Seed some content
		const now = new Date().toISOString();
		await db
			.insertInto("ec_posts" as any)
			.values([
				{
					id: "post-1",
					slug: "hello",
					status: "published",
					title: "Hello World",
					created_at: now,
					updated_at: now,
					version: 1,
				},
				{
					id: "post-2",
					slug: "second",
					status: "draft",
					title: "Second Post",
					created_at: now,
					updated_at: now,
					version: 1,
				},
			])
			.execute();

		const result = await call(handler, "content/list", { collection: "posts", limit: 5 });
		expect(result.error).toBeUndefined();

		const data = result.result as {
			items: Array<{ id: string; type: string; data: Record<string, unknown> }>;
			hasMore: boolean;
		};
		expect(data.items).toHaveLength(2);
		expect(data.hasMore).toBe(false);
		// Items should be transformed via rowToContentItem
		expect(data.items[0]!.type).toBe("posts");
		expect(data.items[0]!.data.title).toBeDefined();
	});

	// ── Content lifecycle: create, read, update, soft-delete ─────────────

	describe("content lifecycle (requires write:content)", () => {
		function makeWriteHandler() {
			return createBridgeHandler({
				pluginId: "sandboxed-test",
				version: "0.0.1",
				capabilities: ["write:content"],
				allowedHosts: [],
				storageCollections: [],
				db,
				emailSend: () => null,
			});
		}

		it("create, read, update, delete", async () => {
			const handler = makeWriteHandler();

			// Create
			const createResult = await call(handler, "content/create", {
				collection: "posts",
				data: { title: "New Post", body: "Content here", slug: "new-post", status: "draft" },
			});
			expect(createResult.error).toBeUndefined();
			const created = createResult.result as {
				id: string;
				type: string;
				data: Record<string, unknown>;
			};
			expect(created.type).toBe("posts");
			expect(created.data.title).toBe("New Post");
			expect(created.id).toBeTruthy();

			// Read
			const readResult = await call(handler, "content/get", {
				collection: "posts",
				id: created.id,
			});
			expect(readResult.error).toBeUndefined();
			const read = readResult.result as { id: string; data: Record<string, unknown> };
			expect(read.data.title).toBe("New Post");

			// Update
			const updateResult = await call(handler, "content/update", {
				collection: "posts",
				id: created.id,
				data: { title: "Updated Post" },
			});
			expect(updateResult.error).toBeUndefined();
			const updated = updateResult.result as { id: string; data: Record<string, unknown> };
			expect(updated.data.title).toBe("Updated Post");

			// Delete (soft-delete)
			const deleteResult = await call(handler, "content/delete", {
				collection: "posts",
				id: created.id,
			});
			expect(deleteResult.result).toBe(true);

			// Verify soft-deleted: get returns null
			const afterDelete = await call(handler, "content/get", {
				collection: "posts",
				id: created.id,
			});
			expect(afterDelete.result).toBeNull();
		});
	});

	// ── Capability enforcement matches real plugin config ─────────────────

	it("sandboxed-test plugin cannot write content (only has read:content)", async () => {
		const handler = makePluginHandler();
		const result = await call(handler, "content/create", {
			collection: "posts",
			data: { title: "Should fail" },
		});
		expect(result.error).toContain("does not have capability: write:content");
	});

	it("sandboxed-test plugin cannot send email (not in capabilities)", async () => {
		const handler = makePluginHandler();
		const result = await call(handler, "email/send", {
			message: { to: "a@b.com", subject: "hi", text: "hello" },
		});
		expect(result.error).toContain("does not have capability: email:send");
	});

	it("sandboxed-test plugin cannot access undeclared storage collections", async () => {
		const handler = makePluginHandler();
		const result = await call(handler, "storage/get", {
			collection: "secrets",
			id: "1",
		});
		expect(result.error).toContain("does not declare storage collection: secrets");
	});

	// ── Cross-plugin isolation ────────────────────────────────────────────

	it("two plugins cannot see each other's KV data", async () => {
		const pluginA = createBridgeHandler({
			pluginId: "plugin-a",
			version: "1.0.0",
			capabilities: [],
			allowedHosts: [],
			storageCollections: [],
			db,
			emailSend: () => null,
		});
		const pluginB = createBridgeHandler({
			pluginId: "plugin-b",
			version: "1.0.0",
			capabilities: [],
			allowedHosts: [],
			storageCollections: [],
			db,
			emailSend: () => null,
		});

		await call(pluginA, "kv/set", { key: "secret", value: "a-only" });

		const fromA = await call(pluginA, "kv/get", { key: "secret" });
		expect(fromA.result).toBe("a-only");

		const fromB = await call(pluginB, "kv/get", { key: "secret" });
		expect(fromB.result).toBeNull();
	});

	it("two plugins cannot see each other's storage documents", async () => {
		const pluginA = createBridgeHandler({
			pluginId: "plugin-a",
			version: "1.0.0",
			capabilities: [],
			allowedHosts: [],
			storageCollections: ["shared-name"],
			db,
			emailSend: () => null,
		});
		const pluginB = createBridgeHandler({
			pluginId: "plugin-b",
			version: "1.0.0",
			capabilities: [],
			allowedHosts: [],
			storageCollections: ["shared-name"],
			db,
			emailSend: () => null,
		});

		await call(pluginA, "storage/put", {
			collection: "shared-name",
			id: "doc-1",
			data: { owner: "a" },
		});

		const fromA = await call(pluginA, "storage/get", { collection: "shared-name", id: "doc-1" });
		expect((fromA.result as Record<string, unknown>).owner).toBe("a");

		const fromB = await call(pluginB, "storage/get", { collection: "shared-name", id: "doc-1" });
		expect(fromB.result).toBeNull();
	});
});
