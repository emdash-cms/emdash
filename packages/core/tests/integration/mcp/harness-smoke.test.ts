/**
 * Smoke test for the MCP integration harness.
 *
 * Verifies the `connectMcpHarness()` plumbing is sound: real DB, real
 * runtime, real MCP client/server pair. This is not bug coverage — it
 * just guards against regressions in the harness itself. Bug-specific
 * tests live in the other files in this directory.
 */

import { Role } from "@emdash-cms/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { connectMcpHarness, extractJson, type McpHarness } from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

describe("MCP harness smoke", () => {
	let harness: McpHarness;
	let dbCleanup: () => Promise<void>;

	beforeEach(async () => {
		const db = await setupTestDatabaseWithCollections();
		harness = await connectMcpHarness({
			db,
			userId: "user_admin",
			userRole: Role.ADMIN,
		});
		dbCleanup = () => teardownTestDatabase(db);
	});

	afterEach(async () => {
		await harness.cleanup();
		await dbCleanup();
	});

	it("exposes registered MCP tools via tools/list", async () => {
		const tools = await harness.client.listTools();
		const names = tools.tools.map((t) => t.name);
		expect(names).toContain("content_list");
		expect(names).toContain("content_create");
		expect(names).toContain("schema_list_collections");
	});

	it("can call schema_list_collections and get the seeded test collections", async () => {
		const result = await harness.client.callTool({
			name: "schema_list_collections",
			arguments: {},
		});
		expect(result.isError).toBeFalsy();
		const { items } = extractJson<{ items: Array<{ slug: string }> }>(result);
		const slugs = items.map((c) => c.slug);
		expect(slugs).toContain("post");
		expect(slugs).toContain("page");
	});

	it("can round-trip a simple content_create + content_get", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Hello" } },
		});
		expect(created.isError).toBeFalsy();
		const createdItem = extractJson<{ item: { id: string; slug: string } }>(created);

		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id: createdItem.item.id },
		});
		expect(got.isError).toBeFalsy();
		const gotItem = extractJson<{ item: { id: string; slug: string } }>(got);
		expect(gotItem.item.id).toBe(createdItem.item.id);
		expect(gotItem.item.slug).toBe("hello");
	});
});
