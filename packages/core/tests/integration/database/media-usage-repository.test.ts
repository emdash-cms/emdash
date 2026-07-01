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

	it("flips generations without removing stale occurrence rows", async () => {
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

		expect(rows).toHaveLength(2);
		expect(rows).toContainEqual({ generation: first.currentGeneration, media_id: "media-old" });
		expect(rows).toContainEqual({ generation: second.currentGeneration, media_id: "media-new" });
	});

	it("writes ISO occurrence timestamps for safe cleanup cutoffs", async () => {
		await repo.replaceSource(contentSource("entry1", "live"), [occurrence("hero", "media-live")]);

		const row = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select("created_at")
			.where("source_key", "=", "content:posts:entry1:live")
			.executeTakeFirstOrThrow();

		expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
	});

	it("deletes stale generations by age and limit without deleting current usage", async () => {
		const first = await repo.replaceSource(contentSource("entry1", "live"), [
			occurrence("hero", "media-old-1"),
			occurrence("body", "media-old-2"),
		]);
		const second = await repo.replaceSource(contentSource("entry1", "live"), [
			occurrence("hero", "media-current"),
		]);

		await ctx.db
			.updateTable("_emdash_media_usage")
			.set({ created_at: "2026-01-01T00:00:00.000Z" })
			.where("source_key", "=", "content:posts:entry1:live")
			.execute();

		expect(await repo.deleteStaleGenerationsOlderThan("2026-01-02T00:00:00.000Z", 1)).toBe(1);
		expect(await repo.findCurrentUsageByMediaId("media-current")).toHaveLength(1);

		let rows = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select(["generation", "media_id"])
			.where("source_key", "=", "content:posts:entry1:live")
			.execute();

		expect(rows).toHaveLength(2);
		expect(rows).toContainEqual({
			generation: second.currentGeneration,
			media_id: "media-current",
		});
		expect(rows.filter((row) => row.generation === first.currentGeneration)).toHaveLength(1);

		expect(await repo.deleteStaleGenerationsOlderThan("2026-01-02T00:00:00.000Z", 10)).toBe(1);

		rows = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select(["generation", "media_id"])
			.where("source_key", "=", "content:posts:entry1:live")
			.execute();

		expect(rows).toEqual([{ generation: second.currentGeneration, media_id: "media-current" }]);
	});

	it("does not delete in-flight generations that are newer than or equal to the published source", async () => {
		await repo.replaceSource(contentSource("entry1", "live"), [
			occurrence("hero", "media-current"),
		]);

		await ctx.db
			.updateTable("_emdash_media_usage_sources")
			.set({ indexed_at: "2026-01-01T00:00:00.000Z" })
			.where("source_key", "=", "content:posts:entry1:live")
			.execute();
		await ctx.db
			.updateTable("_emdash_media_usage")
			.set({ created_at: "2026-01-01T00:00:00.000Z" })
			.where("source_key", "=", "content:posts:entry1:live")
			.execute();
		await ctx.db
			.insertInto("_emdash_media_usage")
			.values({
				id: "pending-occurrence",
				source_key: "content:posts:entry1:live",
				generation: "pending-generation",
				field_slug: "hero",
				field_path: "pendingHero",
				occurrence_index: 0,
				reference_type: "image_field",
				media_id: "media-pending",
				provider: "local",
				provider_asset_id: "media-pending",
				media_kind: "image",
				mime_type: null,
				created_at: "2026-01-01T00:00:01.000Z",
			})
			.execute();
		await ctx.db
			.insertInto("_emdash_media_usage")
			.values({
				id: "pending-same-ms-occurrence",
				source_key: "content:posts:entry1:live",
				generation: "pending-same-ms-generation",
				field_slug: "body",
				field_path: "pendingSameMs",
				occurrence_index: 0,
				reference_type: "image_field",
				media_id: "media-pending-same-ms",
				provider: "local",
				provider_asset_id: "media-pending-same-ms",
				media_kind: "image",
				mime_type: null,
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();

		expect(await repo.deleteStaleGenerationsOlderThan("2026-01-02T00:00:00.000Z", 10)).toBe(0);

		const rows = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select(["generation", "media_id"])
			.where("source_key", "=", "content:posts:entry1:live")
			.execute();

		expect(rows).toContainEqual({ generation: "pending-generation", media_id: "media-pending" });
		expect(rows).toContainEqual({
			generation: "pending-same-ms-generation",
			media_id: "media-pending-same-ms",
		});
		expect(await repo.findCurrentUsageByMediaId("media-current")).toHaveLength(1);
	});

	it("deletes abandoned generations from failed partial replacements by age", async () => {
		await repo.replaceSource(contentSource("entry1", "live"), [
			occurrence("hero", "media-current"),
		]);

		await ctx.db
			.updateTable("_emdash_media_usage_sources")
			.set({ indexed_at: "2026-01-01T00:00:00.000Z" })
			.where("source_key", "=", "content:posts:entry1:live")
			.execute();
		await ctx.db
			.insertInto("_emdash_media_usage")
			.values({
				id: "abandoned-occurrence",
				source_key: "content:posts:entry1:live",
				generation: "abandoned-generation",
				field_slug: "hero",
				field_path: "abandonedHero",
				occurrence_index: 0,
				reference_type: "image_field",
				media_id: "media-abandoned",
				provider: "local",
				provider_asset_id: "media-abandoned",
				media_kind: "image",
				mime_type: null,
				created_at: "2026-01-01T00:00:01.000Z",
			})
			.execute();

		expect(await repo.deleteStaleGenerationsOlderThan("2026-01-02T00:00:00.000Z", 10)).toBe(0);
		expect(await repo.deleteAbandonedGenerationsOlderThan("2026-01-02T00:00:00.000Z", 10)).toBe(1);
		expect(await repo.findCurrentUsageByMediaId("media-current")).toHaveLength(1);

		const abandoned = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select("id")
			.where("id", "=", "abandoned-occurrence")
			.execute();
		expect(abandoned).toEqual([]);
	});

	it("persists source freshness metadata and clears previous source errors", async () => {
		await repo.markSourceAttempted(
			contentSource("entry1", "live", {
				sourceCompleteness: "failed",
				lastAttemptedAt: "2026-01-01T00:00:00.000Z",
				lastErrorCode: "EXTRACT_FAILED",
			}),
		);

		const source = await repo.replaceSource(
			contentSource("entry1", "live", {
				sourceUpdatedAt: "2026-01-01T00:00:01.000Z",
				sourceVersion: 7,
				sourceFingerprint: "fingerprint-entry1-live",
				sourceCompleteness: "complete",
				lastAttemptedAt: "2026-01-01T00:00:02.000Z",
			}),
			[occurrence("hero", "media-hero")],
		);

		expect(source).toEqual(
			expect.objectContaining({
				sourceUpdatedAt: "2026-01-01T00:00:01.000Z",
				sourceVersion: 7,
				sourceFingerprint: "fingerprint-entry1-live",
				sourceCompleteness: "complete",
				lastAttemptedAt: "2026-01-01T00:00:02.000Z",
				lastErrorCode: null,
			}),
		);
	});

	it("marks failed source attempts without replacing current usage", async () => {
		await repo.replaceSource(contentSource("entry1", "live"), [occurrence("hero", "media-live")]);

		const failed = await repo.markSourceAttempted(
			contentSource("entry1", "live", {
				sourceCompleteness: "failed",
				lastAttemptedAt: "2026-01-01T00:00:00.000Z",
				lastErrorCode: "LOAD_FAILED",
			}),
		);

		expect(failed).toEqual(
			expect.objectContaining({
				sourceCompleteness: "failed",
				lastAttemptedAt: "2026-01-01T00:00:00.000Z",
				lastErrorCode: "LOAD_FAILED",
			}),
		);
		expect(await repo.findCurrentUsageByMediaId("media-live")).toHaveLength(1);

		const neverIndexed = await repo.markSourceAttempted(
			contentSource("entry-missing", "draft", {
				lastAttemptedAt: "2026-01-01T00:00:01.000Z",
				lastErrorCode: "MISSING_TABLE",
			}),
		);

		expect(neverIndexed).toEqual(
			expect.objectContaining({
				sourceKey: "content:posts:entry-missing:draft",
				sourceCompleteness: "failed",
				lastAttemptedAt: "2026-01-01T00:00:01.000Z",
				lastErrorCode: "MISSING_TABLE",
			}),
		);

		const rows = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select("id")
			.where("source_key", "=", "content:posts:entry-missing:draft")
			.execute();
		expect(rows).toEqual([]);
	});

	it("preserves existing source metadata when marking a minimal failed attempt", async () => {
		await repo.replaceSource(
			contentSource("entry1", "live", {
				contentTitle: "Existing title",
				sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
				sourceVersion: 3,
				sourceFingerprint: "fingerprint-existing",
			}),
			[occurrence("hero", "media-live")],
		);

		const failed = await repo.markSourceAttempted({
			sourceKey: "content:posts:entry1:live",
			sourceType: "content",
			sourceVariant: "live",
			lastAttemptedAt: "2026-01-01T00:00:01.000Z",
			lastErrorCode: "LOAD_FAILED",
		});

		expect(failed).toEqual(
			expect.objectContaining({
				collectionSlug: "posts",
				contentId: "entry1",
				contentTitle: "Existing title",
				sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
				sourceVersion: 3,
				sourceFingerprint: "fingerprint-existing",
				sourceCompleteness: "failed",
				lastErrorCode: "LOAD_FAILED",
			}),
		);
		expect(await repo.findCurrentUsageByMediaId("media-live")).toHaveLength(1);
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

	it("deletes content sources by collection", async () => {
		await repo.replaceSource(contentSource("entry1", "live"), [occurrence("hero", "media-live")]);
		await repo.replaceSource(contentSource("entry2", "draft"), [occurrence("hero", "media-draft")]);
		await repo.replaceSource(contentSource("entry1", "live", { collectionSlug: "pages" }), [
			occurrence("hero", "media-page"),
		]);

		expect(await repo.deleteCollectionSources("posts")).toBe(2);
		expect(await repo.findCurrentUsageByMediaId("media-live")).toEqual([]);
		expect(await repo.findCurrentUsageByMediaId("media-draft")).toEqual([]);
		expect(await repo.findCurrentUsageByMediaId("media-page")).toHaveLength(1);
	});

	it("deletes specific source keys in D1-safe batches", async () => {
		await repo.replaceSource(contentSource("entry1", "live"), [occurrence("hero", "media-live")]);
		await repo.replaceSource(contentSource("entry1", "draft"), [occurrence("hero", "media-draft")]);
		await repo.replaceSource(contentSource("entry2", "live"), [occurrence("hero", "media-other")]);

		expect(
			await repo.deleteSources([
				"content:posts:entry1:live",
				"content:posts:entry1:draft",
				"content:posts:entry1:live",
			]),
		).toBe(2);
		expect(await repo.findCurrentUsageByMediaId("media-live")).toEqual([]);
		expect(await repo.findCurrentUsageByMediaId("media-draft")).toEqual([]);
		expect(await repo.findCurrentUsageByMediaId("media-other")).toHaveLength(1);
	});

	it("deletes orphan occurrence rows by age in bounded batches", async () => {
		await ctx.db
			.insertInto("_emdash_media_usage")
			.values([
				{
					id: "orphan-1",
					source_key: "missing-source-1",
					generation: "generation-1",
					field_slug: "hero",
					field_path: "hero",
					occurrence_index: 0,
					reference_type: "image_field",
					media_id: "media-orphan-1",
					provider: "local",
					provider_asset_id: "media-orphan-1",
					media_kind: "image",
					mime_type: null,
					created_at: "2026-01-01T00:00:00.000Z",
				},
				{
					id: "orphan-newer",
					source_key: "missing-source-2",
					generation: "generation-1",
					field_slug: "hero",
					field_path: "hero",
					occurrence_index: 0,
					reference_type: "image_field",
					media_id: "media-orphan-newer",
					provider: "local",
					provider_asset_id: "media-orphan-newer",
					media_kind: "image",
					mime_type: null,
					created_at: "2026-01-02T00:00:00.000Z",
				},
			])
			.execute();

		expect(await repo.deleteOrphanOccurrencesOlderThan("2026-01-01T12:00:00.000Z", 1)).toBe(1);
		expect(await repo.deleteOrphanOccurrencesOlderThan("2026-01-01T12:00:00.000Z", 10)).toBe(0);

		const remaining = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select("id")
			.where("source_key", "=", "missing-source-2")
			.execute();
		expect(remaining).toEqual([{ id: "orphan-newer" }]);
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

	it("paginates current media usage by occurrence id", async () => {
		await repo.replaceSource(contentSource("entry1", "live"), [
			occurrence("hero", "media-shared"),
			occurrence("body", "media-shared"),
		]);
		await repo.replaceSource(contentSource("entry2", "live"), [occurrence("hero", "media-shared")]);

		const page1 = await repo.findCurrentUsagePageByMediaId("media-shared", { limit: 2 });
		expect(page1.items).toHaveLength(2);
		expect(page1.nextCursor).toEqual(expect.any(String));

		const page2 = await repo.findCurrentUsagePageByMediaId("media-shared", {
			limit: 2,
			cursor: page1.nextCursor,
		});
		expect(page2.items).toHaveLength(1);
		expect(page2.nextCursor).toBeUndefined();

		const occurrenceIds = [...page1.items, ...page2.items].map((record) => record.occurrence.id);
		expect(occurrenceIds).toEqual(occurrenceIds.toSorted());
	});

	it("paginates current provider-asset usage by occurrence id", async () => {
		await repo.replaceSource(contentSource("entry1", "live"), [
			occurrence("video", "mux-video-1", {
				provider: "mux",
				providerAssetId: "mux-video-1",
				mediaId: null,
			}),
			occurrence("video2", "mux-video-1", {
				provider: "mux",
				providerAssetId: "mux-video-1",
				mediaId: null,
			}),
		]);

		const page1 = await repo.findCurrentUsagePageByProviderAsset("mux", "mux-video-1", {
			limit: 1,
		});
		const page2 = await repo.findCurrentUsagePageByProviderAsset("mux", "mux-video-1", {
			limit: 1,
			cursor: page1.nextCursor,
		});

		expect(page1.items).toHaveLength(1);
		expect(page2.items).toHaveLength(1);
		expect(page2.items[0]!.occurrence.id > page1.items[0]!.occurrence.id).toBe(true);
	});

	it("upserts and reads index status rows", async () => {
		const running = await repo.upsertIndexStatus({
			adapterId: "content-media",
			scopeType: "collection",
			scopeKey: "posts",
			status: "running",
			startedAt: "2026-01-01T00:00:00.000Z",
			cursor: "cursor-1",
			indexedSourceCount: 2,
			failedSourceCount: 1,
			lastErrorCode: "LOAD_FAILED",
			updatedAt: "2026-01-01T00:00:01.000Z",
		});

		expect(running).toEqual({
			adapterId: "content-media",
			scopeType: "collection",
			scopeKey: "posts",
			status: "running",
			schemaVersion: 1,
			startedAt: "2026-01-01T00:00:00.000Z",
			completedAt: null,
			cursor: "cursor-1",
			indexedSourceCount: 2,
			failedSourceCount: 1,
			lastErrorCode: "LOAD_FAILED",
			updatedAt: "2026-01-01T00:00:01.000Z",
		});

		const complete = await repo.upsertIndexStatus({
			adapterId: "content-media",
			scopeType: "collection",
			scopeKey: "posts",
			status: "complete",
			startedAt: "2026-01-01T00:00:00.000Z",
			completedAt: "2026-01-01T00:00:02.000Z",
			indexedSourceCount: 3,
			updatedAt: "2026-01-01T00:00:02.000Z",
		});

		expect(complete).toEqual(
			expect.objectContaining({
				status: "complete",
				completedAt: "2026-01-01T00:00:02.000Z",
				cursor: null,
				indexedSourceCount: 3,
				failedSourceCount: 0,
				lastErrorCode: null,
			}),
		);
		expect(
			await repo.findIndexStatus({
				adapterId: "content-media",
				scopeType: "collection",
				scopeKey: "posts",
			}),
		).toEqual(complete);
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
