import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MediaUsageRepairResponse } from "../../../src/api/schemas/media-usage.js";
import type { Database } from "../../../src/database/types.js";
import {
	connectMcpHarness,
	extractJson,
	extractText,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN_ID = "user_admin";

describe("media_usage_repair", () => {
	let db: Kysely<Database>;
	let harness: McpHarness | undefined;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await harness?.cleanup();
		await teardownTestDatabase(db);
	});

	it("advertises scope and collection in its input schema", async () => {
		harness = await connectAdminHarness(db);

		const { tools } = await harness.client.listTools();
		const tool = tools.find(({ name }) => name === "media_usage_repair");

		expect(tool).toBeDefined();
		expect(tool?.inputSchema).toMatchObject({
			type: "object",
			properties: {
				scope: expect.any(Object),
				collection: expect.any(Object),
			},
			required: expect.arrayContaining(["scope"]),
		});
	});

	it("repairs one collection", async () => {
		harness = await connectAdminHarness(db);

		const result = await harness.client.callTool({
			name: "media_usage_repair",
			arguments: { scope: "collection", collection: "post" },
		});

		expect(result.isError, extractText(result)).toBeFalsy();
		const response = extractJson<MediaUsageRepairResponse>(result);
		expect(response.status).toBe("complete");
		expect(response.collections).toHaveLength(1);
		expect(response.collections[0]).toMatchObject({ collection: "post", status: "complete" });
	});

	it("repairs all collections in deterministic order", async () => {
		harness = await connectAdminHarness(db);

		const result = await harness.client.callTool({
			name: "media_usage_repair",
			arguments: { scope: "all" },
		});

		expect(result.isError, extractText(result)).toBeFalsy();
		const response = extractJson<MediaUsageRepairResponse>(result);
		expect(response.status).toBe("complete");
		expect(response.collections.map(({ collection }) => collection)).toEqual(["page", "post"]);
	});

	it("returns an unknown collection as a structured failed repair", async () => {
		harness = await connectAdminHarness(db);

		const result = await harness.client.callTool({
			name: "media_usage_repair",
			arguments: { scope: "collection", collection: "missing" },
		});

		expect(result.isError, extractText(result)).toBeFalsy();
		const response = extractJson<MediaUsageRepairResponse>(result);
		expect(response.status).toBe("failed");
		expect(response.collections).toEqual([
			expect.objectContaining({
				collection: "missing",
				status: "failed",
				lastErrorCode: "COLLECTION_NOT_FOUND",
			}),
		]);
	});

	it("requires the admin token scope", async () => {
		harness = await connectMcpHarness({
			db,
			userId: ADMIN_ID,
			userRole: Role.ADMIN,
			tokenScopes: ["media:write"],
		});

		const result = await harness.client.callTool({
			name: "media_usage_repair",
			arguments: { scope: "all" },
		});

		expect(result.isError).toBe(true);
		expect((result as { _meta?: { code?: string } })._meta?.code).toBe("INSUFFICIENT_SCOPE");
	});

	it("requires the Admin role", async () => {
		harness = await connectMcpHarness({
			db,
			userId: "user_editor",
			userRole: Role.EDITOR,
			tokenScopes: ["admin"],
		});

		const result = await harness.client.callTool({
			name: "media_usage_repair",
			arguments: { scope: "all" },
		});

		expect(result.isError).toBe(true);
		expect((result as { _meta?: { code?: string } })._meta?.code).toBe("INSUFFICIENT_PERMISSIONS");
	});

	it.each([
		["missing scope", {}],
		["missing collection", { scope: "collection" }],
		["collection supplied for all scope", { scope: "all", collection: "post" }],
		["uppercase collection", { scope: "collection", collection: "Post" }],
		["hyphenated collection", { scope: "collection", collection: "blog-post" }],
		["empty collection", { scope: "collection", collection: "" }],
		["collection longer than 63 characters", { scope: "collection", collection: "a".repeat(64) }],
		["unknown property", { scope: "all", force: true }],
	] as const)("rejects %s at the tool boundary", async (_case, args) => {
		harness = await connectAdminHarness(db);

		const result = await harness.client.callTool({
			name: "media_usage_repair",
			arguments: args,
		});

		expect(result.isError).toBe(true);
	});
});

function connectAdminHarness(db: Kysely<Database>): Promise<McpHarness> {
	return connectMcpHarness({
		db,
		userId: ADMIN_ID,
		userRole: Role.ADMIN,
		tokenScopes: ["admin"],
	});
}
