import { ulid } from "ulidx";
import { it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate, handleContentUpdate } from "../../../src/api/handlers/content.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("save-side media-field MIME validation", (dialect) => {
	let ctx: DialectTestContext;
	let pdfMediaId: string;
	let zipMediaId: string;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);

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

	it("rejects external-provider ref when mimeType is present and does not match allowlist", async () => {
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

	it("accepts external-provider ref when mimeType matches the allowlist", async () => {
		const result = await handleContentCreate(ctx.db, "posts", {
			slug: "p4b",
			data: {
				title: "p4b",
				attachment: {
					id: "ext-2",
					provider: "s3",
					filename: "remote.pdf",
					mimeType: "application/pdf",
					src: "https://example.com/remote.pdf",
				},
			},
		});
		expect(result.success).toBe(true);
	});

	it("rejects external-provider ref with no mimeType when field is constrained", async () => {
		const result = await handleContentCreate(ctx.db, "posts", {
			slug: "p4c",
			data: {
				title: "p4c",
				attachment: {
					id: "ext-3",
					provider: "s3",
					filename: "remote-unknown",
					src: "https://example.com/remote-unknown",
				},
			},
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("INVALID_MIME_FOR_FIELD");
	});

	it("rejects local-provider ref with non-string id when field is constrained", async () => {
		const result = await handleContentCreate(ctx.db, "posts", {
			slug: "p4d",
			data: {
				title: "p4d",
				attachment: { id: 123, provider: "local", filename: "doc.pdf" },
			},
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("INVALID_MIME_FOR_FIELD");
	});

	it("file/image field without allowedMimeTypes is not validated", async () => {
		// Insert a second file field with no MIME restrictions (backwards-compat assertion)
		const collection = await ctx.db
			.selectFrom("_emdash_collections")
			.select("id")
			.where("slug", "=", "posts")
			.executeTakeFirstOrThrow();

		await ctx.db
			.insertInto("_emdash_fields")
			.values({
				id: ulid(),
				collection_id: collection.id,
				slug: "unconstrained",
				label: "Unconstrained",
				type: "file",
				column_type: "TEXT",
				required: 0,
				unique: 0,
				default_value: null,
				validation: null,
				widget: "file",
				options: null,
				sort_order: 20,
			})
			.execute();

		await ctx.db.schema.alterTable("ec_posts").addColumn("unconstrained", "text").execute();

		// Attaching a zip to the unconstrained field alongside a valid PDF in the
		// constrained field — the save should succeed because unconstrained has no
		// allowedMimeTypes.
		const result = await handleContentCreate(ctx.db, "posts", {
			slug: "p5",
			data: {
				title: "p5",
				attachment: { id: pdfMediaId, provider: "local", filename: "doc.pdf" },
				unconstrained: { id: zipMediaId, provider: "local", filename: "x.zip" },
			},
		});
		expect(result.success).toBe(true);
	});

	it("local media ID not found in DB returns INVALID_MIME_FOR_FIELD", async () => {
		// Reference a made-up ULID that doesn't exist in the media table
		const missingId = ulid();
		const result = await handleContentCreate(ctx.db, "posts", {
			slug: "p6",
			data: {
				title: "p6",
				attachment: { id: missingId, provider: "local", filename: "ghost.pdf" },
			},
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("INVALID_MIME_FOR_FIELD");
	});
});
