import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { EmDashValidationError } from "../../../src/database/repositories/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { BlockTypeRegistry } from "../../../src/schema/block-type-registry.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const unsafeUrls = [
	"javascript:alert(document.cookie)",
	"JavaScript:alert(1)",
	" javascript:alert(1)",
	"data:text/html,<script>alert(1)</script>",
	"vbscript:msgbox(1)",
	"//evil.example/path",
	"/\\evil.example/path",
	"/\t/evil.example/path",
	"ftp://files.example/file",
];

const unsafeRepositoryValues = [
	"javascript:alert(document.cookie)",
	"JavaScript:alert(1)",
	" javascript:alert(1)",
	"\tjava\nscript:alert(1)",
	"data:text/html,<script>alert(1)</script>",
	"vbscript:msgbox(1)",
	"ftp://files.example/file",
	"//evil.example/path",
	"/\\evil.example/path",
	"/\t/evil.example/path",
	"\t//evil.example/path",
	"\u0000//evil.example/path",
	"\\\\evil.example/path",
];

const safeUrls = [
	"https://example.com/page",
	"http://localhost:4321/path?q=1",
	"mailto:hello@example.com",
	"tel:+15550100",
	"/about",
	"/blog/post?x=1#heading",
	"#section",
];

describeEachDialect("url field scheme restriction", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;
	let repo: ContentRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "links", label: "Links" });
		await registry.createField("links", { slug: "title", label: "Title", type: "string" });
		await registry.createField("links", { slug: "website", label: "Website", type: "url" });
		await registry.createField("links", {
			slug: "rows",
			label: "Rows",
			type: "repeater",
			validation: {
				subFields: [{ slug: "href", type: "url", label: "Href" }],
			},
		});
		await new BlockTypeRegistry(ctx.db).createBlockType({
			slug: "link_card",
			label: "Link card",
			fields: [
				{ slug: "href", label: "Href", type: "url" },
				{
					slug: "items",
					label: "Items",
					type: "repeater",
					validation: { subFields: [{ slug: "href", label: "Href", type: "url" }] },
				},
			],
		});
		await registry.createField("links", {
			slug: "blocks",
			label: "Blocks",
			type: "blocks",
			validation: { allowedTypes: ["link_card"] },
		});
		runtime = createTestRuntime(ctx.db);
		repo = new ContentRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	describe("REST and MCP handlers", () => {
		it.each(unsafeUrls)("rejects %j on create", async (website) => {
			const result = await runtime.handleContentCreate("links", {
				slug: "unsafe-create",
				data: { website },
			});

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("VALIDATION_ERROR");
		});

		it.each(unsafeUrls)("rejects %j in a repeater sub-field", async (href) => {
			const result = await runtime.handleContentCreate("links", {
				slug: "unsafe-row",
				data: { rows: [{ href }] },
			});

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("VALIDATION_ERROR");
		});

		it.each(unsafeUrls)("rejects %j on update", async (website) => {
			const created = await runtime.handleContentCreate("links", {
				slug: "update-target",
				data: { website: "https://example.com" },
			});
			expect(created.success).toBe(true);
			if (!created.success) return;

			const result = await runtime.handleContentUpdate("links", created.data.item.id, {
				data: { website },
			});

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("VALIDATION_ERROR");
		});

		it.each([
			{ href: "/\\evil.example/path" },
			{ href: "/about", items: [{ href: "\u0000//evil.example/path" }] },
		])("rejects unsafe URL fields inside blocks", async (blockData) => {
			const result = await runtime.handleContentCreate("links", {
				slug: "unsafe-block",
				data: { blocks: [{ _type: "link_card", ...blockData }] },
			});

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("VALIDATION_ERROR");
		});

		it.each(safeUrls)("accepts %j", async (website) => {
			const result = await runtime.handleContentCreate("links", {
				slug: "safe-create",
				data: { website, rows: [{ href: website }] },
			});

			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.item.data.website).toBe(website);
		});
	});

	describe("repository writes used by seeds and plugins", () => {
		it.each(unsafeRepositoryValues)("create rejects %j", async (website) => {
			await expect(repo.create({ type: "links", data: { website } })).rejects.toThrow(
				EmDashValidationError,
			);
		});

		it.each(unsafeRepositoryValues)("create rejects %j in a repeater sub-field", async (href) => {
			await expect(repo.create({ type: "links", data: { rows: [{ href }] } })).rejects.toThrow(
				EmDashValidationError,
			);
		});

		it.each(unsafeRepositoryValues)("update rejects %j", async (website) => {
			const created = await repo.create({ type: "links", data: { title: "Target" } });
			await expect(repo.update("links", created.id, { data: { website } })).rejects.toThrow(
				EmDashValidationError,
			);
		});

		it.each(unsafeRepositoryValues)("updateDraftAware rejects %j", async (website) => {
			const created = await repo.create({ type: "links", data: { title: "Target" } });
			await expect(
				repo.updateDraftAware("links", created.id, { data: { website } }),
			).rejects.toThrow(EmDashValidationError);
		});

		it.each(safeUrls)("create accepts %j", async (website) => {
			const created = await repo.create({
				type: "links",
				data: { website, rows: [{ href: website }] },
			});
			expect(created.data.website).toBe(website);
		});

		it("create rejects a repeater sent as a JSON string", async () => {
			const rows = JSON.stringify([{ href: "javascript:alert(1)" }]);
			await expect(repo.create({ type: "links", data: { rows } })).rejects.toThrow(
				EmDashValidationError,
			);
		});

		it("create accepts values without a scheme", async () => {
			const created = await repo.create({ type: "links", data: { website: "www.example.com" } });
			expect(created.data.website).toBe("www.example.com");
		});
	});

	describe("values stored before the restriction", () => {
		const legacy = "javascript:alert(1)";

		async function createLegacyEntry(): Promise<string> {
			const created = await repo.create({
				type: "links",
				slug: "legacy",
				data: { title: "Legacy", website: "https://example.com" },
			});
			await sql`UPDATE ec_links SET website = ${legacy} WHERE id = ${created.id}`.execute(ctx.db);
			return created.id;
		}

		it("stay readable", async () => {
			const id = await createLegacyEntry();

			const found = await repo.findById("links", id);
			expect(found?.data.website).toBe(legacy);

			const result = await runtime.handleContentGet("links", id);
			expect(result.success).toBe(true);
		});

		it("do not block updates that leave the field untouched", async () => {
			const id = await createLegacyEntry();

			const viaHandler = await runtime.handleContentUpdate("links", id, {
				data: { title: "Renamed" },
			});
			expect(viaHandler.success).toBe(true);

			const viaPlugin = await repo.updateDraftAware("links", id, { data: { title: "Again" } });
			expect(viaPlugin.data.title).toBe("Again");
		});

		it("are refused when written back", async () => {
			const id = await createLegacyEntry();

			const result = await runtime.handleContentUpdate("links", id, {
				data: { title: "Renamed", website: legacy },
			});

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("VALIDATION_ERROR");
		});
	});
});
