import { Role } from "@emdash-cms/auth";
import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaRepository } from "../../../src/database/repositories/media.js";
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

	it("links rich text images of library files inside blocks to their media items", async () => {
		const media = await new MediaRepository(ctx.db).create({
			filename: "hero.png",
			mimeType: "image/png",
			storageKey: "01K0HEROIMAGE.png",
		});
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "pages",
				data: {
					title: "Landing",
					layout: [
						{
							_type: "hero",
							heading: "Welcome",
							body: [
								{
									_type: "image",
									_key: "img",
									asset: { url: "/_emdash/api/media/file/01K0HEROIMAGE.png" },
								},
							],
						},
					],
				},
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const created = extractJson<ContentEnvelope>(result);
		const read = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "pages", id: created.item.id },
		});

		expect(extractJson<ContentEnvelope>(read).item.data.layout).toEqual([
			expect.objectContaining({
				body: [
					expect.objectContaining({
						asset: { _ref: media.id, url: "/_emdash/api/media/file/01K0HEROIMAGE.png" },
					}),
				],
			}),
		]);
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

	it("infers a single block type and converts its nested Markdown on create and update", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "pages",
				data: { layout: [{ heading: "Hello", body: "**Welcome**" }] },
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const created = extractJson<ContentEnvelope>(result);
		const original = (created.item.data.layout as Array<Record<string, unknown>>)[0]!;
		expect(original).toMatchObject({
			_type: "hero",
			_version: 1,
			body: [{ _type: "block", children: [{ text: "Welcome", marks: ["strong"] }] }],
		});
		const edited: Record<string, unknown> = { ...original, body: "**Updated**" };
		delete edited._type;
		const updated = await harness.client.callTool({
			name: "content_update",
			arguments: {
				collection: "pages",
				id: created.item.id,
				_rev: await currentRev(harness.client, "pages", created.item.id),
				data: { layout: [edited] },
			},
		});
		expect(updated.isError, extractText(updated)).toBeFalsy();
		const read = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "pages", id: created.item.id, markdown: true },
		});
		expect(read.isError, extractText(read)).toBeFalsy();
		const stored = (
			extractJson<ContentEnvelope>(read).item.data.layout as Array<Record<string, unknown>>
		)[0]!;
		expect(stored).toMatchObject({
			_type: "hero",
			_version: original._version,
			_key: original._key,
			heading: "Hello",
		});
		expect(String(stored.body).trim()).toBe("**Updated**");
	});
});
