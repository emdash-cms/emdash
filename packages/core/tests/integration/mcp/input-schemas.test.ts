/**
 * MCP tool input schema tests.
 *
 * The MCP SDK validates `arguments` against each tool's `inputSchema`
 * (Zod) before the handler runs. These tests pin down what happens at
 * that boundary: missing required fields, wrong types, invalid enum
 * values, out-of-range numeric inputs, etc.
 *
 * The expected behavior is consistent: invalid arguments produce a
 * structured error response (`isError: true`) with a message that names
 * the offending field. We assert specifically that errors at this layer
 * remain user-friendly across the omnibus fix.
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { connectMcpHarness, extractText, type McpHarness } from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN_ID = "user_admin";

describe("MCP input schema validation", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("content_create rejects missing required collection argument", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: { data: { title: "T" } } as unknown as Record<string, unknown>,
		});
		expect(result.isError).toBe(true);
	});

	it("content_create rejects wrong-type for data field (string instead of object)", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: "not-an-object" } as unknown as Record<
				string,
				unknown
			>,
		});
		expect(result.isError).toBe(true);
	});

	it("content_create with status enum value outside the enum is rejected", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "T" },
				status: "weird-status",
			} as unknown as Record<string, unknown>,
		});
		expect(result.isError).toBe(true);
	});

	it("content_list rejects out-of-range limit (e.g. negative)", async () => {
		const result = await harness.client.callTool({
			name: "content_list",
			arguments: { collection: "post", limit: -5 },
		});
		expect(result.isError).toBe(true);
	});

	it("content_list rejects non-integer limit", async () => {
		const result = await harness.client.callTool({
			name: "content_list",
			arguments: { collection: "post", limit: 5.7 },
		});
		expect(result.isError).toBe(true);
	});

	it("content_list rejects order outside enum", async () => {
		const result = await harness.client.callTool({
			name: "content_list",
			arguments: { collection: "post", order: "sideways" } as unknown as Record<string, unknown>,
		});
		expect(result.isError).toBe(true);
	});

	it("schema_create_collection rejects supports value outside enum", async () => {
		const result = await harness.client.callTool({
			name: "schema_create_collection",
			arguments: {
				slug: "x",
				label: "X",
				supports: ["drafts", "garbage"],
			} as unknown as Record<string, unknown>,
		});
		expect(result.isError).toBe(true);
	});

	it("schema_create_field rejects type outside enum", async () => {
		const result = await harness.client.callTool({
			name: "schema_create_field",
			arguments: {
				collection: "post",
				slug: "x",
				label: "X",
				type: "magic",
			} as unknown as Record<string, unknown>,
		});
		expect(result.isError).toBe(true);
	});

	it("content_get rejects missing id", async () => {
		const result = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post" } as unknown as Record<string, unknown>,
		});
		expect(result.isError).toBe(true);
	});

	it("content_schedule rejects missing scheduledAt", async () => {
		const result = await harness.client.callTool({
			name: "content_schedule",
			arguments: { collection: "post", id: "01ANY" } as unknown as Record<string, unknown>,
		});
		expect(result.isError).toBe(true);
	});

	it("media_list with limit > 100 is rejected by inputSchema", async () => {
		const result = await harness.client.callTool({
			name: "media_list",
			arguments: { limit: 500 },
		});
		expect(result.isError).toBe(true);
	});

	it("revision_list with limit > 50 is rejected by inputSchema", async () => {
		const result = await harness.client.callTool({
			name: "revision_list",
			arguments: { collection: "post", id: "01x", limit: 500 },
		});
		expect(result.isError).toBe(true);
	});

	it("input validation error messages name the offending field", async () => {
		const result = await harness.client.callTool({
			name: "schema_create_collection",
			arguments: { slug: "Has-Caps", label: "Bad" },
		});
		expect(result.isError).toBe(true);
		// Ideally the error names the field "slug" or shows the regex /
		// pattern violation. Today the SDK error usually does — pin that
		// behavior so it doesn't regress.
		expect(extractText(result)).toMatch(/slug|pattern|regex|invalid/i);
	});
});
