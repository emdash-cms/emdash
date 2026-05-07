import { ulid } from "ulidx";
import { it, expect, describe, beforeEach, afterEach } from "vitest";

import { handleContentCreate, handleContentUpdate } from "../../../src/api/handlers/content.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describe("save-side media-field MIME validation", () => {
	let ctx: DialectTestContext;
	let pdfMediaId: string;
	let zipMediaId: string;

	beforeEach(async () => {
		ctx = await setupForDialect("sqlite");

		// Create a posts collection with title and attachment fields
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({
			slug: "posts",
			label: "Posts",
			labelSingular: "Post",
		});
		await registry.createField("posts", {
			slug: "title",
			label: "Title",
			type: "string",
		});

		// Look up the collection id
		const collection = await ctx.db
			.selectFrom("_emdash_collections")
			.select("id")
			.where("slug", "=", "posts")
			.executeTakeFirstOrThrow();

		// Add a `file` field to posts that allows only PDFs
		await ctx.db
			.insertInto("_emdash_fields")
			.values({
				id: ulid(),
				collection_id: collection.id,
				slug: "attachment",
				label: "Attachment",
				type: "file",
				column_type: "TEXT",
				required: 0,
				unique: 0,
				default_value: null,
				validation: JSON.stringify({ allowedMimeTypes: ["application/pdf"] }),
				widget: "file",
				options: null,
				sort_order: 10,
			})
			.execute();

		// Add the column to ec_posts
		await ctx.db.schema.alterTable("ec_posts").addColumn("attachment", "text").execute();

		// Seed two media items
		pdfMediaId = ulid();
		zipMediaId = ulid();
		await ctx.db
			.insertInto("media")
			.values([
				{
					id: pdfMediaId,
					filename: "doc.pdf",
					mime_type: "application/pdf",
					size: 100,
					width: null,
					height: null,
					alt: null,
					caption: null,
					storage_key: "doc.pdf",
					content_hash: null,
					blurhash: null,
					dominant_color: null,
					status: "ready",
					author_id: null,
				},
				{
					id: zipMediaId,
					filename: "x.zip",
					mime_type: "application/zip",
					size: 100,
					width: null,
					height: null,
					alt: null,
					caption: null,
					storage_key: "x.zip",
					content_hash: null,
					blurhash: null,
					dominant_color: null,
					status: "ready",
					author_id: null,
				},
			])
			.execute();
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("accepts a PDF in a PDF-only field", async () => {
		const result = await handleContentCreate(ctx.db, "posts", {
			slug: "p1",
			data: {
				title: "p1",
				attachment: { id: pdfMediaId, provider: "local", filename: "doc.pdf" },
			},
		});
		expect(result.success).toBe(true);
	});

	it("rejects a zip in a PDF-only field on create", async () => {
		const result = await handleContentCreate(ctx.db, "posts", {
			slug: "p2",
			data: {
				title: "p2",
				attachment: { id: zipMediaId, provider: "local", filename: "x.zip" },
			},
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("INVALID_MIME_FOR_FIELD");
	});

	it("rejects a zip in a PDF-only field on update", async () => {
		const created = await handleContentCreate(ctx.db, "posts", {
			slug: "p3",
			data: { title: "p3" },
		});
		if (!created.success) throw new Error("seed failed");

		const result = await handleContentUpdate(ctx.db, "posts", created.data.item.id, {
			data: {
				attachment: { id: zipMediaId, provider: "local", filename: "x.zip" },
			},
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("INVALID_MIME_FOR_FIELD");
	});

	it("validates external-provider values via the value's mimeType", async () => {
		const result = await handleContentCreate(ctx.db, "posts", {
			slug: "p4",
			data: {
				title: "p4",
				attachment: {
					id: "ext-1",
					provider: "s3",
					filename: "remote.zip",
					mimeType: "application/zip",
					src: "https://example.com/remote.zip",
				},
			},
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("INVALID_MIME_FOR_FIELD");
	});
});
