import { afterEach, beforeEach, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { buildContentMediaUsageSourceKey } from "../../../src/media/usage/source-key.js";
import { loadContentMediaUsageSnapshots } from "../../../src/media/usage/content-snapshots.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("content media usage snapshots", (dialect) => {
	let ctx: DialectTestContext;
	let registry: SchemaRegistry;
	let contentRepo: ContentRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		registry = new SchemaRegistry(ctx.db);
		contentRepo = new ContentRepository(ctx.db);

		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "hero", label: "Hero", type: "image" });
		await registry.createField("posts", { slug: "attachment", label: "Attachment", type: "file" });
		await registry.createField("posts", {
			slug: "sections",
			label: "Sections",
			type: "repeater",
			validation: { subFields: [{ slug: "image", type: "image", label: "Image" }] },
		});
		await registry.createField("posts", { slug: "body", label: "Body", type: "portableText" });
		await registry.createField("posts", { slug: "raw_data", label: "Raw Data", type: "json" });
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("builds a columns snapshot from stored content fields", async () => {
		const item = await contentRepo.create({
			type: "posts",
			slug: "hello-world",
			status: "published",
			locale: "en",
			data: {
				title: "Hello World",
				hero: { id: "media-hero", provider: "local", mimeType: "image/webp" },
				attachment: { id: "media-file", provider: "local", mimeType: "application/pdf" },
				sections: [{ image: { id: "media-section", provider: "local" } }],
				body: [{ _type: "image", asset: { _ref: "media-body" } }],
				raw_data: { id: "media-ignored" },
			},
		});

		const result = await loadContentMediaUsageSnapshots(ctx.db, "posts", item.id);

		expect(result.success).toBe(true);
		if (!result.success) throw new Error(result.error);
		expect(result.snapshots).toHaveLength(1);
		const snapshot = result.snapshots[0]!;

		expect(snapshot.source).toEqual(
			expect.objectContaining({
				sourceKey: buildContentMediaUsageSourceKey({
					collectionSlug: "posts",
					contentId: item.id,
					sourceVariant: "columns",
				}),
				sourceType: "content",
				collectionSlug: "posts",
				contentId: item.id,
				sourceVariant: "columns",
				locale: "en",
				translationGroup: item.translationGroup,
				contentSlug: "hello-world",
				contentTitle: "Hello World",
				contentStatus: "published",
				contentScheduledAt: null,
				contentDeletedAt: null,
				revisionId: null,
				sourceUpdatedAt: item.updatedAt,
				sourceVersion: item.version,
			}),
		);
		expect(snapshot.fields).toEqual([
			{ slug: "attachment", type: "file" },
			{ slug: "body", type: "portableText" },
			{ slug: "hero", type: "image" },
			{
				slug: "sections",
				type: "repeater",
				validation: { subFields: [{ slug: "image", type: "image" }] },
			},
		]);
		expect(snapshot.occurrences).toEqual([
			expect.objectContaining({ fieldPath: "attachment", mediaId: "media-file" }),
			expect.objectContaining({ fieldPath: "body[0].asset._ref", mediaId: "media-body" }),
			expect.objectContaining({ fieldPath: "hero", mediaId: "media-hero" }),
			expect.objectContaining({ fieldPath: "sections[0].image", mediaId: "media-section" }),
		]);
		expect(snapshot.occurrences).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ mediaId: "media-ignored" })]),
		);
	});

	it("returns a typed not-found result for missing content", async () => {
		const result = await loadContentMediaUsageSnapshots(ctx.db, "posts", "missing-content");

		expect(result).toEqual({ success: false, error: "CONTENT_NOT_FOUND" });
	});
});
