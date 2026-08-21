/**
 * Capability vocabulary tests for the workerd sandbox.
 *
 * Manifests reach the bridge in either vocabulary: current names from a
 * freshly published plugin, or legacy aliases carried by an older
 * manifest. Both must authorize the same operations, and denials must
 * name the current capability.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createBridgeHandler } from "../src/sandbox/bridge-handler.js";

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
		.addColumn("status", "text")
		.addColumn("author_id", "text")
		.addColumn("created_at", "text")
		.addColumn("updated_at", "text")
		.addColumn("published_at", "text")
		.addColumn("scheduled_at", "text")
		.addColumn("deleted_at", "text")
		.addColumn("version", "integer")
		.addColumn("live_revision_id", "text")
		.addColumn("draft_revision_id", "text")
		.addColumn("locale", "text")
		.addColumn("translation_group", "text")
		.addColumn("title", "text")
		.execute();

	await db.schema
		.createTable("media")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("filename", "text")
		.addColumn("mime_type", "text")
		.addColumn("size", "integer")
		.addColumn("storage_key", "text")
		.addColumn("created_at", "text")
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

describe("Bridge Handler capability vocabulary", () => {
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

	function makeHandler(capabilities: string[], allowedHosts: string[] = []) {
		return createBridgeHandler({
			pluginId: "test-plugin",
			version: "1.0.0",
			capabilities,
			allowedHosts,
			storageCollections: [],
			db,
			emailSend: () => null,
		});
	}

	async function call(
		capabilities: string[],
		method: string,
		body: Record<string, unknown> = {},
		allowedHosts: string[] = [],
	) {
		const request = new Request(`http://bridge/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const response = await makeHandler(capabilities, allowedHosts)(request);
		return response.json() as Promise<{ result?: any; error?: string }>;
	}

	describe.each([
		{
			domain: "content read",
			current: "content:read",
			legacy: "read:content",
			method: "content/list",
			body: { collection: "posts" },
		},
		{
			domain: "content write",
			current: "content:write",
			legacy: "write:content",
			method: "content/create",
			body: { collection: "posts", data: { title: "Drafted" } },
		},
		{
			domain: "media read",
			current: "media:read",
			legacy: "read:media",
			method: "media/get",
			body: { id: "missing" },
		},
		{
			domain: "media write",
			current: "media:write",
			legacy: "write:media",
			method: "media/delete",
			body: { id: "missing" },
		},
		{
			domain: "users read",
			current: "users:read",
			legacy: "read:users",
			method: "users/get",
			body: { id: "missing" },
		},
	])("$domain", ({ current, legacy, method, body }) => {
		it("authorizes the current capability name", async () => {
			const result = await call([current], method, body);
			expect(result.error).toBeUndefined();
		});

		it("authorizes the legacy capability name", async () => {
			const result = await call([legacy], method, body);
			expect(result.error).toBeUndefined();
		});

		it("denies with the current capability name when undeclared", async () => {
			const result = await call([], method, body);
			expect(result.error).toBe(`Missing capability: ${current}`);
		});
	});

	describe("network", () => {
		const BLOCKED_URL = "http://blocked.test/resource";

		it.each(["network:request", "network:fetch"])(
			"applies the allowedHosts policy with %s",
			async (capability) => {
				const result = await call([capability], "http/fetch", { url: BLOCKED_URL }, [
					"allowed.test",
				]);
				expect(result.error).toContain("not allowed to fetch from host");
			},
		);

		it.each(["network:request:unrestricted", "network:fetch:any"])(
			"skips the allowedHosts policy with %s",
			async (capability) => {
				const result = await call([capability], "http/fetch", { url: BLOCKED_URL });
				expect(result.error).not.toContain("Missing capability");
				expect(result.error).not.toContain("allowedHosts");
			},
		);

		it("denies with the current capability name when undeclared", async () => {
			const result = await call([], "http/fetch", { url: BLOCKED_URL });
			expect(result.error).toBe("Missing capability: network:request");
		});
	});

	describe("capability implication", () => {
		it("does not let content:write authorize reads", async () => {
			const result = await call(["content:write"], "content/list", { collection: "posts" });
			expect(result.error).toBe("Missing capability: content:read");
		});

		it("does not let write:content authorize reads", async () => {
			const result = await call(["write:content"], "content/list", { collection: "posts" });
			expect(result.error).toBe("Missing capability: content:read");
		});
	});

	describe("unknown capability names", () => {
		it.each([
			{
				domain: "content read",
				method: "content/list",
				body: { collection: "posts" },
				denied: "content:read",
			},
			{
				domain: "content write",
				method: "content/create",
				body: { collection: "posts", data: { title: "Drafted" } },
				denied: "content:write",
			},
			{ domain: "media read", method: "media/list", body: {}, denied: "media:read" },
			{ domain: "users read", method: "users/list", body: {}, denied: "users:read" },
			{
				domain: "network",
				method: "http/fetch",
				body: { url: "https://example.com/" },
				denied: "network:request",
			},
		])(
			"$domain stays denied and names the current capability",
			async ({ method, body, denied }) => {
				const result = await call(["content:everything", "made:up"], method, body);
				expect(result.error).toBe(`Missing capability: ${denied}`);
			},
		);
	});

	describe("publishable manifest", () => {
		const MANIFEST_CAPABILITIES = [
			"content:read",
			"content:write",
			"media:read",
			"users:read",
			"network:request",
		];

		it("authorizes every operation the manifest declares", async () => {
			const list = await call(MANIFEST_CAPABILITIES, "content/list", { collection: "posts" });
			expect(list.error).toBeUndefined();

			const created = await call(MANIFEST_CAPABILITIES, "content/create", {
				collection: "posts",
				data: { title: "Drafted" },
			});
			expect(created.error).toBeUndefined();

			const media = await call(MANIFEST_CAPABILITIES, "media/get", { id: "missing" });
			expect(media.error).toBeUndefined();

			const user = await call(MANIFEST_CAPABILITIES, "users/get", { id: "missing" });
			expect(user.error).toBeUndefined();
		});
	});
});
