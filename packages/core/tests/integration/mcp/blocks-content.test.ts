import { Role } from "@emdash-cms/auth";
import { afterEach, beforeEach, expect, it } from "vitest";

import { BlockTypeRegistry } from "../../../src/schema/block-type-registry.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	connectMcpHarness,
	currentRev,
	extractJson,
	extractText,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

interface ContentEnvelope {
	item: { id: string; data: Record<string, unknown> };
}

describeEachDialect("MCP blocks content writes", (dialect) => {
	let ctx: DialectTestContext;
	let harness: McpHarness;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		await new BlockTypeRegistry(ctx.db).createBlockType({
			slug: "hero",
			label: "Hero",
			fields: [
				{ slug: "heading", label: "Heading", type: "string", required: true },
				{ slug: "body", label: "Body", type: "portableText" },
			],
		});
		const schema = new SchemaRegistry(ctx.db);
		await schema.createCollection({
			slug: "pages",
			label: "Pages",
			supports: ["drafts", "revisions"],
		});
		await schema.createField("pages", { slug: "title", label: "Title", type: "string" });
		await schema.createField("pages", {
			slug: "layout",
			label: "Layout",
			type: "blocks",
			validation: { allowedTypes: ["hero"] },
		});
		harness = await connectMcpHarness({ db: ctx.db, userId: "admin", userRole: Role.ADMIN });
	});

	afterEach(async () => {
		await harness?.cleanup();
		await teardownForDialect(ctx);
	});

	it("creates content with an empty blocks field when the field is omitted", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "pages", data: { title: "No layout" } },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const created = extractJson<ContentEnvelope>(result);
		const read = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "pages", id: created.item.id },
		});
		expect(read.isError, extractText(read)).toBeFalsy();
		expect(extractJson<ContentEnvelope>(read).item.data).toMatchObject({
			title: "No layout",
			layout: [],
		});
	});

	it("preserves stored blocks when an update changes only another field", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "pages",
				data: { title: "Before", layout: [{ _type: "hero", heading: "Keep me" }] },
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const created = extractJson<ContentEnvelope>(result);
		const updated = await harness.client.callTool({
			name: "content_update",
			arguments: {
				collection: "pages",
				id: created.item.id,
				data: { title: "After" },
				_rev: await currentRev(harness.client, "pages", created.item.id),
			},
		});
		expect(updated.isError, extractText(updated)).toBeFalsy();
		const read = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "pages", id: created.item.id },
		});
		expect(read.isError, extractText(read)).toBeFalsy();
		expect(extractJson<ContentEnvelope>(read).item.data).toEqual({
			title: "After",
			layout: created.item.data.layout,
		});
	});

	it.each([null, "not an array", {}])(
		"rejects a supplied non-array blocks value: %j",
		async (layout) => {
			const result = await harness.client.callTool({
				name: "content_create",
				arguments: { collection: "pages", data: { layout } },
			});
			expect(result.isError).toBe(true);
			expect(extractText(result)).toContain("[VALIDATION_ERROR] layout: must be an array");
		},
	);
});
