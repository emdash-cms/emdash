import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	connectMcpHarness,
	extractJson,
	extractText,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("blocks schema MCP tools", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		harness = await connectMcpHarness({ db, userId: "admin", userRole: Role.ADMIN });
	});

	afterEach(async () => {
		await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("creates, versions, activates, and expands a block type through shared handlers", async () => {
		const listedTools = await harness.client.listTools();
		for (const name of [
			"schema_list_block_types",
			"schema_get_block_type",
			"schema_create_block_type",
			"schema_update_block_type",
			"schema_activate_block_type_version",
		]) {
			expect(listedTools.tools.find((tool) => tool.name === name)?.inputSchema).toMatchObject({
				type: "object",
			});
		}
		const createdResult = await harness.client.callTool({
			name: "schema_create_block_type",
			arguments: {
				slug: "hero",
				label: "Hero",
				fields: [{ slug: "heading", label: "Heading", type: "string", required: true }],
			},
		});
		expect(createdResult.isError, extractText(createdResult)).toBeFalsy();
		const created = extractJson<{
			item: { versions: Array<{ fingerprint: string; version: number }> };
		}>(createdResult).item;

		const versionedResult = await harness.client.callTool({
			name: "schema_update_block_type",
			arguments: {
				slug: "hero",
				expectedFingerprint: created.versions[0]!.fingerprint,
				breaking: true,
				fields: [{ slug: "title", label: "Title", type: "string", required: true }],
			},
		});
		expect(versionedResult.isError, extractText(versionedResult)).toBeFalsy();
		const versioned = extractJson<{
			item: { currentVersion: number; versions: Array<{ version: number; fingerprint: string }> };
		}>(versionedResult).item;
		expect(versioned.currentVersion).toBe(1);
		expect(versioned.versions.map((version) => version.version)).toEqual([1, 2]);

		const activated = await harness.client.callTool({
			name: "schema_activate_block_type_version",
			arguments: {
				slug: "hero",
				version: 2,
				expectedFingerprint: versioned.versions[0]!.fingerprint,
			},
		});
		expect(activated.isError, extractText(activated)).toBeFalsy();
		expect(extractJson<{ item: { currentVersion: number } }>(activated).item.currentVersion).toBe(
			2,
		);

		const listed = await harness.client.callTool({
			name: "schema_list_block_types",
			arguments: {},
		});
		expect(extractJson<{ items: unknown[] }>(listed).items).toHaveLength(1);
	});

	it("creates a blocks field and converts nested Portable Text Markdown", async () => {
		await harness.client.callTool({
			name: "schema_create_block_type",
			arguments: {
				slug: "hero",
				label: "Hero",
				fields: [
					{ slug: "heading", label: "Heading", type: "string", required: true },
					{ slug: "body", label: "Body", type: "portableText" },
				],
			},
		});
		await new SchemaRegistry(db).createCollection({ slug: "pages", label: "Pages" });
		const fieldResult = await harness.client.callTool({
			name: "schema_create_field",
			arguments: {
				collection: "pages",
				slug: "layout",
				label: "Layout",
				type: "blocks",
				validation: { allowedTypes: ["hero"], maxItems: 10 },
			},
		});
		expect(fieldResult.isError, extractText(fieldResult)).toBeFalsy();

		const schemaResult = await harness.client.callTool({
			name: "schema_get_collection",
			arguments: { slug: "pages" },
		});
		const collection = extractJson<{
			fields: Array<{ slug: string; blockTypes?: Array<{ slug: string }> }>;
		}>(schemaResult);
		expect(collection.fields.find((field) => field.slug === "layout")?.blockTypes).toEqual([
			expect.objectContaining({ slug: "hero" }),
		]);

		const createResult = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "pages",
				slug: "home",
				data: {
					layout: [{ _type: "hero", heading: "Hello", body: "**Welcome**" }],
				},
			},
		});
		expect(createResult.isError, extractText(createResult)).toBeFalsy();
		const created = extractJson<{ item: { id: string } }>(createResult);
		const readResult = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "pages", id: created.item.id, markdown: true },
		});
		const read = extractJson<{
			item: { data: { layout: Array<{ body: unknown; _key: string; _version: number }> } };
		}>(readResult);
		expect(String(read.item.data.layout[0]?.body).trim()).toBe("**Welcome**");
		expect(read.item.data.layout[0]).toMatchObject({
			_version: 1,
			_key: expect.any(String),
		});
	});
});
