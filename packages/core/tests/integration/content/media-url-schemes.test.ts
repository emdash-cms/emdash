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
	"\tjava\nscript:alert(1)",
	"\u0000javascript:alert(1)",
	"data:text/html,<script>alert(1)</script>",
	"vbscript:msgbox(1)",
];

const safeUrls = [
	"https://cdn.example/report.pdf",
	"http://localhost:4321/report.pdf",
	"/downloads/report.pdf",
	"downloads/report.pdf",
];

function externalFile(src: string) {
	return { id: "", provider: "external", src, filename: "report.pdf" };
}

const unsafeUrl = "javascript:alert(1)";

// Field data for one entry, with the unsafe URL in each place a media value carries a URL.
const unsafePlacements: { place: string; data: Record<string, unknown> }[] = [
	{ place: "a file src", data: { document: externalFile(unsafeUrl) } },
	{ place: "a bare file string", data: { document: unsafeUrl } },
	{ place: "an image src", data: { hero: { id: "", provider: "external", src: unsafeUrl } } },
	{ place: "a bare image string", data: { hero: unsafeUrl } },
	{
		place: "an image previewUrl",
		data: { hero: { id: "photo-1", provider: "photos", previewUrl: unsafeUrl } },
	},
	{
		place: "a dark variant src",
		data: {
			hero: {
				id: "",
				provider: "external",
				src: "https://cdn.example/light.png",
				darkVariant: { id: "", provider: "external", src: unsafeUrl },
			},
		},
	},
	{
		place: "a repeater image sub-field",
		data: { gallery: [{ image: { id: "", provider: "external", src: unsafeUrl } }] },
	},
];

describeEachDialect("media value URL scheme restriction", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;
	let repo: ContentRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "hero", label: "Hero", type: "image" });
		await registry.createField("posts", { slug: "document", label: "Document", type: "file" });
		await registry.createField("posts", {
			slug: "gallery",
			label: "Gallery",
			type: "repeater",
			validation: { subFields: [{ slug: "image", type: "image", label: "Image" }] },
		});
		await new BlockTypeRegistry(ctx.db).createBlockType({
			slug: "download",
			label: "Download",
			fields: [
				{ slug: "file", label: "File", type: "file" },
				{ slug: "cover", label: "Cover", type: "image" },
			],
		});
		await registry.createField("posts", {
			slug: "blocks",
			label: "Blocks",
			type: "blocks",
			validation: { allowedTypes: ["download"] },
		});
		runtime = createTestRuntime(ctx.db);
		repo = new ContentRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	describe("REST and MCP handlers", () => {
		it.each(unsafeUrls)("rejects %j on create", async (url) => {
			const result = await runtime.handleContentCreate("posts", {
				slug: "unsafe-create",
				data: { document: externalFile(url) },
			});

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("VALIDATION_ERROR");
		});

		it.each(unsafePlacements)("rejects an unsafe URL as $place on create", async ({ data }) => {
			const result = await runtime.handleContentCreate("posts", { slug: "unsafe-create", data });

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("VALIDATION_ERROR");
		});

		it.each(unsafePlacements)("rejects an unsafe URL as $place on update", async ({ data }) => {
			const created = await runtime.handleContentCreate("posts", {
				slug: "update-target",
				data: { document: externalFile("https://cdn.example/report.pdf") },
			});
			expect(created.success).toBe(true);
			if (!created.success) return;

			const result = await runtime.handleContentUpdate("posts", created.data.item.id, { data });

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("VALIDATION_ERROR");
		});

		it.each([
			{ file: externalFile(unsafeUrl) },
			{ cover: { id: "", provider: "external", src: unsafeUrl } },
		])("rejects unsafe media URLs inside blocks", async (blockData) => {
			const result = await runtime.handleContentCreate("posts", {
				slug: "unsafe-block",
				data: { blocks: [{ _type: "download", ...blockData }] },
			});

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("VALIDATION_ERROR");
		});

		it.each(safeUrls)("accepts %j", async (url) => {
			const result = await runtime.handleContentCreate("posts", {
				slug: "safe-create",
				data: {
					document: externalFile(url),
					hero: { id: "", provider: "external", src: url },
					gallery: [{ image: { id: "", provider: "external", src: url } }],
					blocks: [{ _type: "download", file: externalFile(url) }],
				},
			});

			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.item.data.document).toMatchObject({ provider: "external", src: url });
			expect(result.data.item.data.hero).toMatchObject({ provider: "external", src: url });
		});
	});

	describe("repository writes used by seeds and plugins", () => {
		it.each(unsafeUrls)("create rejects %j", async (url) => {
			await expect(
				repo.create({ type: "posts", data: { document: externalFile(url) } }),
			).rejects.toThrow(EmDashValidationError);
		});

		it.each(unsafePlacements)("create rejects an unsafe URL as $place", async ({ data }) => {
			await expect(repo.create({ type: "posts", data })).rejects.toThrow(EmDashValidationError);
		});

		it("create rejects an unsafe URL as a file url", async () => {
			const document = { id: "", provider: "external", url: unsafeUrl };
			await expect(repo.create({ type: "posts", data: { document } })).rejects.toThrow(
				EmDashValidationError,
			);
		});

		it("update rejects an unsafe URL", async () => {
			const created = await repo.create({ type: "posts", data: { title: "Target" } });
			await expect(
				repo.update("posts", created.id, { data: { document: externalFile(unsafeUrl) } }),
			).rejects.toThrow(EmDashValidationError);
		});

		it("updateDraftAware rejects an unsafe URL", async () => {
			const created = await repo.create({ type: "posts", data: { title: "Target" } });
			await expect(
				repo.updateDraftAware("posts", created.id, { data: { document: externalFile(unsafeUrl) } }),
			).rejects.toThrow(EmDashValidationError);
		});

		it("create rejects a media value sent as a JSON string", async () => {
			const document = JSON.stringify(externalFile(unsafeUrl));
			await expect(repo.create({ type: "posts", data: { document } })).rejects.toThrow(
				EmDashValidationError,
			);
		});

		it.each([
			{
				place: "a file src",
				data: { document: { id: "", provider: "external", src: [unsafeUrl] } },
			},
			{ place: "an image src", data: { hero: { id: "", provider: "external", src: [unsafeUrl] } } },
			{
				place: "a dark variant src",
				data: {
					hero: {
						id: "",
						provider: "external",
						src: "https://cdn.example/light.png",
						darkVariant: { id: "", provider: "external", src: [unsafeUrl] },
					},
				},
			},
			{
				place: "a repeater image sub-field src",
				data: { gallery: [{ image: { id: "", provider: "external", src: [unsafeUrl] } }] },
			},
			{
				place: "a media value sent as JSON array text",
				data: { hero: JSON.stringify([unsafeUrl]) },
			},
		])("create rejects a URL that is not text in $place", async ({ data }) => {
			await expect(repo.create({ type: "posts", data })).rejects.toThrow(EmDashValidationError);
		});

		it("create rejects a repeater sent as a JSON string", async () => {
			const gallery = JSON.stringify([{ image: { id: "", src: unsafeUrl } }]);
			await expect(repo.create({ type: "posts", data: { gallery } })).rejects.toThrow(
				EmDashValidationError,
			);
		});

		it.each([...safeUrls, "//cdn.example/report.pdf"])("create accepts %j", async (url) => {
			const created = await repo.create({
				type: "posts",
				data: { document: externalFile(url), hero: url, gallery: [{ image: url }] },
			});
			expect(created.data.document).toMatchObject({ src: url });
			expect(created.data.hero).toBe(url);
		});
	});

	describe("values stored before the restriction", () => {
		const legacy = externalFile(unsafeUrl);

		async function createLegacyEntry(): Promise<string> {
			const created = await repo.create({
				type: "posts",
				slug: "legacy",
				data: { title: "Legacy", document: externalFile("https://cdn.example/report.pdf") },
			});
			await sql`UPDATE ec_posts SET document = ${JSON.stringify(legacy)} WHERE id = ${created.id}`.execute(
				ctx.db,
			);
			return created.id;
		}

		it("stay readable", async () => {
			const id = await createLegacyEntry();

			const found = await repo.findById("posts", id);
			expect(found?.data.document).toEqual(legacy);

			const result = await runtime.handleContentGet("posts", id);
			expect(result.success).toBe(true);
		});

		it("do not block updates that leave the field untouched", async () => {
			const id = await createLegacyEntry();

			const viaHandler = await runtime.handleContentUpdate("posts", id, {
				data: { title: "Renamed" },
			});
			expect(viaHandler.success).toBe(true);

			const viaPlugin = await repo.updateDraftAware("posts", id, { data: { title: "Again" } });
			expect(viaPlugin.data.title).toBe("Again");
		});

		it("are refused when written back", async () => {
			const id = await createLegacyEntry();

			const result = await runtime.handleContentUpdate("posts", id, {
				data: { title: "Renamed", document: legacy },
			});

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("VALIDATION_ERROR");
		});
	});
});
