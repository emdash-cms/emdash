import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import { SQL_BATCH_SIZE } from "../../../src/utils/chunks.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("MediaUsageRepository", (dialect) => {
	let ctx: DialectTestContext;
	let repo: MediaUsageRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		repo = new MediaUsageRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("replaces a source with a current generation of occurrences", async () => {
		const source = await repo.replaceSource(contentSource("entry1", "live"), [
			occurrence("hero", "media-hero", { mimeType: "image/jpeg", mediaKind: "image" }),
			occurrence("attachment", "media-file", {
				referenceType: "file_field",
				mimeType: "application/pdf",
				mediaKind: "document",
			}),
		]);

		expect(source.currentGeneration).toEqual(expect.any(String));
		expect(source.sourceKey).toBe("content:posts:entry1:live");
		expect(source.sourceVariant).toBe("live");

		const usage = await repo.findCurrentUsageByMediaId("media-hero");
		expect(usage).toEqual([
			{
				source: expect.objectContaining({
					sourceKey: "content:posts:entry1:live",
					collectionSlug: "posts",
					contentId: "entry1",
					contentSlug: "hello-world",
					contentTitle: "Hello World",
					currentGeneration: source.currentGeneration,
				}),
				occurrence: expect.objectContaining({
					fieldSlug: "hero",
					fieldPath: "hero",
					mediaId: "media-hero",
					provider: "local",
					providerAssetId: "media-hero",
					mediaKind: "image",
					mimeType: "image/jpeg",
					generation: source.currentGeneration,
				}),
			},
		]);
	});

	it("flips generations and removes stale occurrence rows", async () => {
		const first = await repo.replaceSource(contentSource("entry1", "live"), [
			occurrence("hero", "media-old"),
		]);
		const second = await repo.replaceSource(contentSource("entry1", "live"), [
			occurrence("hero", "media-new"),
		]);

		expect(second.currentGeneration).not.toBe(first.currentGeneration);
		expect(await repo.findCurrentUsageByMediaId("media-old")).toEqual([]);
		expect(await repo.findCurrentUsageByMediaId("media-new")).toHaveLength(1);

		const rows = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select(["generation", "media_id"])
			.where("source_key", "=", "content:posts:entry1:live")
			.execute();

		expect(rows).toEqual([{ generation: second.currentGeneration, media_id: "media-new" }]);
	});

	it("supports empty replacement while preserving the source row", async () => {
		const first = await repo.replaceSource(contentSource("entry1", "live"), [
			occurrence("hero", "media-old"),
		]);
		const second = await repo.replaceSource(contentSource("entry1", "live"), []);

		expect(second.currentGeneration).not.toBe(first.currentGeneration);
		expect(await repo.findSource("content:posts:entry1:live")).toEqual(
			expect.objectContaining({ currentGeneration: second.currentGeneration }),
		);
		expect(await repo.findCurrentUsageByMediaId("media-old")).toEqual([]);
	});

	it("deletes a single source and its occurrences", async () => {
		await repo.replaceSource(contentSource("entry1", "live"), [occurrence("hero", "media-live")]);
		await repo.replaceSource(contentSource("entry1", "draft"), [occurrence("hero", "media-draft")]);

		expect(await repo.deleteSource("content:posts:entry1:live")).toBe(1);
		expect(await repo.findSource("content:posts:entry1:live")).toBeNull();
		expect(await repo.findCurrentUsageByMediaId("media-live")).toEqual([]);
		expect(await repo.findCurrentUsageByMediaId("media-draft")).toHaveLength(1);
	});

	it("deletes all content sources for one collection and content id", async () => {
		await repo.replaceSource(contentSource("entry1", "live"), [occurrence("hero", "media-live")]);
		await repo.replaceSource(contentSource("entry1", "draft"), [occurrence("hero", "media-draft")]);
		await repo.replaceSource(contentSource("entry2", "live"), [occurrence("hero", "media-other")]);
		await repo.replaceSource(contentSource("entry1", "live", { collectionSlug: "pages" }), [
			occurrence("hero", "media-page"),
		]);

		expect(await repo.deleteContentSources("posts", "entry1")).toBe(2);
		expect(await repo.findCurrentUsageByMediaId("media-live")).toEqual([]);
		expect(await repo.findCurrentUsageByMediaId("media-draft")).toEqual([]);
		expect(await repo.findCurrentUsageByMediaId("media-other")).toHaveLength(1);
		expect(await repo.findCurrentUsageByMediaId("media-page")).toHaveLength(1);
	});

	it("finds current usage by provider asset", async () => {
		await repo.replaceSource(contentSource("entry1", "live"), [
			occurrence("video", "mux-video-1", {
				referenceType: "file_field",
				provider: "mux",
				mediaId: null,
				providerAssetId: "mux-video-1",
				mediaKind: "video",
				mimeType: "video/mp4",
			}),
		]);

		expect(await repo.findCurrentUsageByProviderAsset("mux", "mux-video-1")).toEqual([
			{
				source: expect.objectContaining({ sourceKey: "content:posts:entry1:live" }),
				occurrence: expect.objectContaining({
					mediaId: null,
					provider: "mux",
					providerAssetId: "mux-video-1",
					mediaKind: "video",
					mimeType: "video/mp4",
				}),
			},
		]);
	});

	it("keeps live and draft source keys separate for the same content", async () => {
		await repo.replaceSource(contentSource("entry1", "live"), [occurrence("hero", "media-shared")]);
		await repo.replaceSource(contentSource("entry1", "draft"), [
			occurrence("draftHero", "media-shared", { fieldPath: "draftHero" }),
		]);

		const usage = await repo.findCurrentUsageByMediaId("media-shared");

		expect(usage.map((row) => row.source.sourceKey)).toEqual([
			"content:posts:entry1:draft",
			"content:posts:entry1:live",
		]);
		expect(usage.map((row) => row.source.sourceVariant)).toEqual(["draft", "live"]);
	});

	it("replaces more occurrences than one D1 insert batch", async () => {
		const occurrences = Array.from({ length: SQL_BATCH_SIZE + 7 }, (_, index) =>
			occurrence(`gallery-${index}`, `media-${index}`, {
				fieldPath: `gallery[${index}].image`,
			}),
		);

		const source = await repo.replaceSource(contentSource("entry1", "draft"), occurrences);
		const rows = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select(["generation", "media_id"])
			.where("source_key", "=", source.sourceKey)
			.orderBy("field_path", "asc")
			.execute();

		expect(rows).toHaveLength(SQL_BATCH_SIZE + 7);
		expect(rows.every((row) => row.generation === source.currentGeneration)).toBe(true);
	});
});

function contentSource(
	contentId: string,
	variant: "live" | "draft",
	overrides: Partial<Parameters<MediaUsageRepository["replaceSource"]>[0]> = {},
): Parameters<MediaUsageRepository["replaceSource"]>[0] {
	const collectionSlug = overrides.collectionSlug ?? "posts";
	return {
		sourceKey: `content:${collectionSlug}:${contentId}:${variant}`,
		sourceType: "content",
		collectionSlug,
		contentId,
		sourceVariant: variant,
		locale: "en",
		translationGroup: `tg-${contentId}`,
		contentSlug: "hello-world",
		contentTitle: "Hello World",
		contentStatus: variant === "live" ? "published" : "draft",
		contentScheduledAt: null,
		contentDeletedAt: null,
		revisionId: `rev-${contentId}-${variant}`,
		...overrides,
	};
}

function occurrence(
	fieldSlug: string,
	mediaId: string,
	overrides: Partial<Parameters<MediaUsageRepository["replaceSource"]>[1][number]> = {},
): Parameters<MediaUsageRepository["replaceSource"]>[1][number] {
	return {
		fieldSlug,
		fieldPath: fieldSlug,
		occurrenceIndex: 0,
		referenceType: "image_field",
		mediaId,
		provider: "local",
		providerAssetId: mediaId,
		mediaKind: "image",
		mimeType: null,
		...overrides,
	};
}
