import { sql } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
	MediaUsageRepository,
	type MediaUsageSource,
} from "../../../src/database/repositories/media-usage.js";
import {
	buildContentMediaUsageSourceKey,
	type MediaUsageContentSourceVariant,
} from "../../../src/media/usage/source-key.js";
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
		const source = await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-hero", { mimeType: "image/jpeg", mediaKind: "image" }),
			occurrence("attachment", "media-file", {
				referenceType: "file_field",
				mimeType: "application/pdf",
				mediaKind: "document",
			}),
		]);

		expect(source.currentGeneration).toEqual(expect.any(String));
		expect(source.sourceKey).toBe("content:posts:entry1:columns");
		expect(source.sourceVariant).toBe("columns");

		const usage = await repo.findCurrentUsageByMediaId("media-hero");
		expect(usage).toEqual([
			{
				source: expect.objectContaining({
					sourceKey: "content:posts:entry1:columns",
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
		const first = await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-old"),
		]);
		const second = await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-new"),
		]);

		expect(second.currentGeneration).not.toBe(first.currentGeneration);
		expect(await repo.findCurrentUsageByMediaId("media-old")).toEqual([]);
		expect(await repo.findCurrentUsageByMediaId("media-new")).toHaveLength(1);

		const rows = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select(["generation", "media_id"])
			.where("source_key", "=", "content:posts:entry1:columns")
			.execute();

		expect(rows).toHaveLength(2);
		expect(rows).toContainEqual({ generation: first.currentGeneration, media_id: "media-old" });
		expect(rows).toContainEqual({ generation: second.currentGeneration, media_id: "media-new" });
	});

	it("does not replace a source when the expected generation is stale", async () => {
		const first = await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-old"),
		]);
		const second = await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-concurrent"),
		]);

		const stale = await repo.replaceSourceIfCurrent(
			contentSource("entry1", "columns"),
			[occurrence("hero", "media-stale")],
			first.currentGeneration,
		);

		expect(stale.replaced).toBe(false);
		expect(stale.source).toEqual(
			expect.objectContaining({ currentGeneration: second.currentGeneration }),
		);
		expect((await repo.findSource("content:posts:entry1:columns"))?.currentGeneration).toBe(
			second.currentGeneration,
		);
		expect(await repo.findCurrentUsageByMediaId("media-concurrent")).toHaveLength(1);
		expect(await repo.findCurrentUsageByMediaId("media-stale")).toEqual([]);
	});

	it("uses the guarded write result as the replacement success signal", async () => {
		const first = await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-old"),
		]);

		class StaleReadRepository extends MediaUsageRepository {
			override async findSource(sourceKey: string): Promise<MediaUsageSource | null> {
				const source = await super.findSource(sourceKey);
				if (sourceKey !== first.sourceKey || !source) return source;
				return { ...source, currentGeneration: first.currentGeneration };
			}
		}

		const staleReadRepo = new StaleReadRepository(ctx.db);
		const result = await staleReadRepo.replaceSourceIfCurrent(
			contentSource("entry1", "columns"),
			[occurrence("hero", "media-new")],
			first.currentGeneration,
		);

		expect(result.replaced).toBe(true);
		expect(result.source).toBeNull();
		expect((await repo.findSource(first.sourceKey))?.currentGeneration).not.toBe(
			first.currentGeneration,
		);
		expect(await repo.findCurrentUsageByMediaId("media-new")).toHaveLength(1);
	});

	it("does not create a source observed absent when another writer created it first", async () => {
		const concurrent = await repo.replaceSource(contentSource("entry-new", "columns"), [
			occurrence("hero", "media-concurrent"),
		]);

		const stale = await repo.replaceSourceIfCurrent(
			contentSource("entry-new", "columns"),
			[occurrence("hero", "media-stale")],
			null,
		);

		expect(stale.replaced).toBe(false);
		expect(stale.source).toEqual(
			expect.objectContaining({ currentGeneration: concurrent.currentGeneration }),
		);
		expect(await repo.findCurrentUsageByMediaId("media-concurrent")).toHaveLength(1);
		expect(await repo.findCurrentUsageByMediaId("media-stale")).toEqual([]);
	});

	it("finds source rows by key in a deduplicated map", async () => {
		const columns = await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-columns"),
		]);
		const draft = await repo.replaceSource(contentSource("entry1", "draft_overlay"), [
			occurrence("hero", "media-draft"),
		]);

		const sources = await repo.findSources([
			columns.sourceKey,
			draft.sourceKey,
			columns.sourceKey,
			"content:posts:missing:columns",
		]);

		expect([...sources.keys()].toSorted()).toEqual([columns.sourceKey, draft.sourceKey].toSorted());
		expect(sources.get(columns.sourceKey)).toEqual(
			expect.objectContaining({ currentGeneration: columns.currentGeneration }),
		);
		expect(sources.get(draft.sourceKey)).toEqual(
			expect.objectContaining({ currentGeneration: draft.currentGeneration }),
		);
	});

	it("replaces a source only when nullable source metadata still matches", async () => {
		const observed = await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-old"),
		]);

		const replaced = await repo.replaceSourceIfMatching(
			contentSource("entry1", "columns", {
				sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
				sourceVersion: 2,
				sourceFingerprint: "fingerprint-new",
			}),
			[occurrence("hero", "media-new")],
			observed,
		);

		expect(replaced.replaced).toBe(true);
		expect(replaced.source).toBeNull();
		expect(await repo.findCurrentUsageByMediaId("media-old")).toEqual([]);
		expect(await repo.findCurrentUsageByMediaId("media-new")).toHaveLength(1);
		expect(await repo.findSource(observed.sourceKey)).toEqual(
			expect.objectContaining({
				sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
				sourceVersion: 2,
				sourceFingerprint: "fingerprint-new",
			}),
		);
	});

	it("replaces a source when nullable row timestamps still match", async () => {
		const source = await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-old-null-updated"),
		]);
		await sql`
			UPDATE _emdash_media_usage_sources
			SET updated_at = ${null}
			WHERE source_key = ${source.sourceKey}
		`.execute(ctx.db);
		const observed = await repo.findSource(source.sourceKey);

		const replaced = await repo.replaceSourceIfMatching(
			contentSource("entry1", "columns"),
			[occurrence("hero", "media-new-null-updated")],
			observed,
		);

		expect(observed?.updatedAt).toBeNull();
		expect(replaced.replaced).toBe(true);
		expect(replaced.source).toBeNull();
		expect(await repo.findCurrentUsageByMediaId("media-old-null-updated")).toEqual([]);
		expect(await repo.findCurrentUsageByMediaId("media-new-null-updated")).toHaveLength(1);
	});

	it("does not replace a source when source metadata changed despite the same generation", async () => {
		const observed = await repo.replaceSource(
			contentSource("entry1", "columns", { sourceFingerprint: "fingerprint-observed" }),
			[occurrence("hero", "media-current")],
		);

		await ctx.db
			.updateTable("_emdash_media_usage_sources")
			.set({ source_fingerprint: "fingerprint-concurrent" })
			.where("source_key", "=", observed.sourceKey)
			.execute();

		const stale = await repo.replaceSourceIfMatching(
			contentSource("entry1", "columns", { sourceFingerprint: "fingerprint-stale" }),
			[occurrence("hero", "media-stale")],
			observed,
		);

		expect(stale.replaced).toBe(false);
		expect(stale.source).toEqual(
			expect.objectContaining({
				currentGeneration: observed.currentGeneration,
				sourceFingerprint: "fingerprint-concurrent",
			}),
		);
		expect(await repo.findCurrentUsageByMediaId("media-current")).toHaveLength(1);
		expect(await repo.findCurrentUsageByMediaId("media-stale")).toEqual([]);
	});

	it("does not insert a matching replacement when an observed-absent source was created", async () => {
		const concurrent = await repo.replaceSource(contentSource("entry-new", "columns"), [
			occurrence("hero", "media-concurrent-matching"),
		]);

		const stale = await repo.replaceSourceIfMatching(
			contentSource("entry-new", "columns"),
			[occurrence("hero", "media-stale-matching")],
			null,
		);

		expect(stale.replaced).toBe(false);
		expect(stale.source).toEqual(
			expect.objectContaining({ currentGeneration: concurrent.currentGeneration }),
		);
		expect(await repo.findCurrentUsageByMediaId("media-concurrent-matching")).toHaveLength(1);
		expect(await repo.findCurrentUsageByMediaId("media-stale-matching")).toEqual([]);
	});

	it("does not delete a source when the expected generation is stale", async () => {
		const first = await repo.replaceSource(contentSource("entry1", "draft_overlay"), [
			occurrence("hero", "media-old-draft"),
		]);
		const second = await repo.replaceSource(contentSource("entry1", "draft_overlay"), [
			occurrence("hero", "media-concurrent-draft"),
		]);

		const stale = await repo.deleteSourceIfCurrent(
			"content:posts:entry1:draft_overlay",
			first.currentGeneration,
		);

		expect(stale.deleted).toBe(false);
		expect(stale.source).toEqual(
			expect.objectContaining({ currentGeneration: second.currentGeneration }),
		);
		expect(await repo.findSource("content:posts:entry1:draft_overlay")).toEqual(
			expect.objectContaining({ currentGeneration: second.currentGeneration }),
		);
		expect(await repo.findCurrentUsageByMediaId("media-concurrent-draft")).toHaveLength(1);
	});

	it("deletes a source only when nullable source metadata still matches", async () => {
		const observed = await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-delete"),
		]);

		const deleted = await repo.deleteSourceIfMatching(observed.sourceKey, observed);

		expect(deleted.deleted).toBe(true);
		expect(deleted.source).toBeNull();
		expect(await repo.findCurrentUsageByMediaId("media-delete")).toEqual([]);
	});

	it("does not delete a source when source metadata changed despite the same generation", async () => {
		const observed = await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-preserved-delete"),
		]);

		await ctx.db
			.updateTable("_emdash_media_usage_sources")
			.set({ source_version: 3 })
			.where("source_key", "=", observed.sourceKey)
			.execute();

		const stale = await repo.deleteSourceIfMatching(observed.sourceKey, observed);

		expect(stale.deleted).toBe(false);
		expect(stale.source).toEqual(
			expect.objectContaining({
				currentGeneration: observed.currentGeneration,
				sourceVersion: 3,
			}),
		);
		expect(await repo.findCurrentUsageByMediaId("media-preserved-delete")).toHaveLength(1);
	});

	it("does not delete content-absent sources when source metadata changed", async () => {
		await sql`CREATE TABLE ${sql.ref("ec_posts")} (id text primary key)`.execute(ctx.db);
		const observed = await repo.replaceSource(
			contentSource("orphan-entry", "columns", { sourceFingerprint: "fingerprint-observed" }),
			[occurrence("hero", "media-orphan-observed")],
		);
		const concurrent = await repo.replaceSource(
			contentSource("orphan-entry", "columns", { sourceFingerprint: "fingerprint-concurrent" }),
			[occurrence("hero", "media-orphan-concurrent")],
		);

		const stale = await repo.deleteSourceIfMatchingContentAbsent(
			observed.sourceKey,
			observed,
			"posts",
			"orphan-entry",
		);

		expect(stale.deleted).toBe(false);
		expect(stale.contentPresent).toBe(false);
		expect(stale.source).toEqual(
			expect.objectContaining({
				currentGeneration: concurrent.currentGeneration,
				sourceFingerprint: "fingerprint-concurrent",
			}),
		);
		expect(await repo.findCurrentUsageByMediaId("media-orphan-observed")).toEqual([]);
		expect(await repo.findCurrentUsageByMediaId("media-orphan-concurrent")).toHaveLength(1);
	});

	it("writes ISO occurrence timestamps for safe cleanup cutoffs", async () => {
		await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-live"),
		]);

		const row = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select("created_at")
			.where("source_key", "=", "content:posts:entry1:columns")
			.executeTakeFirstOrThrow();

		expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
	});

	it("deletes stale generations by age and limit without deleting current usage", async () => {
		const first = await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-old-1"),
			occurrence("body", "media-old-2"),
		]);
		const second = await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-current"),
		]);

		await ctx.db
			.updateTable("_emdash_media_usage")
			.set({ created_at: "2026-01-01T00:00:00.000Z" })
			.where("source_key", "=", "content:posts:entry1:columns")
			.execute();

		expect(await repo.deleteStaleGenerationsOlderThan("2026-01-02T00:00:00.000Z", 1)).toBe(1);
		expect(await repo.findCurrentUsageByMediaId("media-current")).toHaveLength(1);

		let rows = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select(["generation", "media_id"])
			.where("source_key", "=", "content:posts:entry1:columns")
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
			.where("source_key", "=", "content:posts:entry1:columns")
			.execute();

		expect(rows).toEqual([{ generation: second.currentGeneration, media_id: "media-current" }]);
	});

	it("does not delete in-flight generations that are newer than or equal to the published source", async () => {
		await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-current"),
		]);

		await ctx.db
			.updateTable("_emdash_media_usage_sources")
			.set({ indexed_at: "2026-01-01T00:00:00.000Z" })
			.where("source_key", "=", "content:posts:entry1:columns")
			.execute();
		await ctx.db
			.updateTable("_emdash_media_usage")
			.set({ created_at: "2026-01-01T00:00:00.000Z" })
			.where("source_key", "=", "content:posts:entry1:columns")
			.execute();
		await ctx.db
			.insertInto("_emdash_media_usage")
			.values({
				id: "pending-occurrence",
				source_key: "content:posts:entry1:columns",
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
				source_key: "content:posts:entry1:columns",
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
			.where("source_key", "=", "content:posts:entry1:columns")
			.execute();

		expect(rows).toContainEqual({ generation: "pending-generation", media_id: "media-pending" });
		expect(rows).toContainEqual({
			generation: "pending-same-ms-generation",
			media_id: "media-pending-same-ms",
		});
		expect(await repo.findCurrentUsageByMediaId("media-current")).toHaveLength(1);
	});

	it("deletes abandoned generations from failed partial replacements by age", async () => {
		await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-current"),
		]);

		await ctx.db
			.updateTable("_emdash_media_usage_sources")
			.set({ indexed_at: "2026-01-01T00:00:00.000Z" })
			.where("source_key", "=", "content:posts:entry1:columns")
			.execute();
		await ctx.db
			.insertInto("_emdash_media_usage")
			.values({
				id: "abandoned-occurrence",
				source_key: "content:posts:entry1:columns",
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
			contentSource("entry1", "columns", {
				sourceCompleteness: "failed",
				lastAttemptedAt: "2026-01-01T00:00:00.000Z",
				lastErrorCode: "EXTRACT_FAILED",
			}),
		);

		const source = await repo.replaceSource(
			contentSource("entry1", "columns", {
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
		await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-live"),
		]);

		const failed = await repo.markSourceAttempted(
			contentSource("entry1", "columns", {
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
			contentSource("entry-missing", "draft_overlay", {
				lastAttemptedAt: "2026-01-01T00:00:01.000Z",
				lastErrorCode: "MISSING_TABLE",
			}),
		);

		expect(neverIndexed).toEqual(
			expect.objectContaining({
				sourceKey: "content:posts:entry-missing:draft_overlay",
				sourceCompleteness: "failed",
				lastAttemptedAt: "2026-01-01T00:00:01.000Z",
				lastErrorCode: "MISSING_TABLE",
			}),
		);

		const rows = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select("id")
			.where("source_key", "=", "content:posts:entry-missing:draft_overlay")
			.execute();
		expect(rows).toEqual([]);
	});

	it("preserves existing source metadata when marking a minimal failed attempt", async () => {
		await repo.replaceSource(
			contentSource("entry1", "columns", {
				contentTitle: "Existing title",
				sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
				sourceVersion: 3,
				sourceFingerprint: "fingerprint-existing",
			}),
			[occurrence("hero", "media-live")],
		);

		const failed = await repo.markSourceAttempted({
			sourceKey: "content:posts:entry1:columns",
			sourceType: "content",
			sourceVariant: "columns",
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

	it("marks failed source attempts only when source metadata still matches", async () => {
		const observed = await repo.replaceSource(
			contentSource("entry1", "columns", {
				sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
				sourceVersion: 7,
				sourceFingerprint: "fingerprint-observed",
			}),
			[occurrence("hero", "media-live-matching-attempt")],
		);

		const attempted = await repo.markSourceAttemptedIfMatching(
			{
				sourceKey: observed.sourceKey,
				sourceType: "content",
				sourceVariant: "columns",
				lastAttemptedAt: "2026-01-01T00:00:01.000Z",
				lastErrorCode: "LOAD_FAILED",
			},
			observed,
		);

		expect(attempted.attempted).toBe(true);
		expect(attempted.source).toBeNull();
		expect(await repo.findSource(observed.sourceKey)).toEqual(
			expect.objectContaining({
				sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
				sourceVersion: 7,
				sourceFingerprint: "fingerprint-observed",
				sourceCompleteness: "failed",
				lastErrorCode: "LOAD_FAILED",
			}),
		);
		expect(await repo.findCurrentUsageByMediaId("media-live-matching-attempt")).toHaveLength(1);
	});

	it("does not mark failed source attempts when source metadata changed", async () => {
		const observed = await repo.replaceSource(
			contentSource("entry1", "columns", { sourceFingerprint: "fingerprint-observed" }),
			[occurrence("hero", "media-preserved-attempt")],
		);
		await ctx.db
			.updateTable("_emdash_media_usage_sources")
			.set({ source_fingerprint: "fingerprint-concurrent" })
			.where("source_key", "=", observed.sourceKey)
			.execute();

		const stale = await repo.markSourceAttemptedIfMatching(
			{
				sourceKey: observed.sourceKey,
				sourceType: "content",
				sourceVariant: "columns",
				lastAttemptedAt: "2026-01-01T00:00:01.000Z",
				lastErrorCode: "LOAD_FAILED",
			},
			observed,
		);

		expect(stale.attempted).toBe(false);
		expect(stale.source).toEqual(
			expect.objectContaining({
				sourceFingerprint: "fingerprint-concurrent",
				sourceCompleteness: "complete",
				lastErrorCode: null,
			}),
		);
		expect(await repo.findCurrentUsageByMediaId("media-preserved-attempt")).toHaveLength(1);
	});

	it("does not mark failed source attempts when attempt metadata changed", async () => {
		const observed = await repo.markSourceAttempted(
			contentSource("entry1", "columns", {
				lastAttemptedAt: "2026-01-01T00:00:00.000Z",
				lastErrorCode: "OLD_FAILURE",
			}),
		);
		await repo.markSourceAttempted(
			contentSource("entry1", "columns", {
				lastAttemptedAt: "2026-01-01T00:00:01.000Z",
				lastErrorCode: "NEW_FAILURE",
			}),
		);

		const stale = await repo.markSourceAttemptedIfMatching(
			contentSource("entry1", "columns", {
				lastAttemptedAt: "2026-01-01T00:00:02.000Z",
				lastErrorCode: "STALE_FAILURE",
			}),
			observed,
		);

		expect(stale.attempted).toBe(false);
		expect(stale.source).toEqual(
			expect.objectContaining({
				lastAttemptedAt: "2026-01-01T00:00:01.000Z",
				lastErrorCode: "NEW_FAILURE",
			}),
		);
	});

	it("inserts a failed source attempt only when an observed-absent source stays absent", async () => {
		const attempted = await repo.markSourceAttemptedIfMatching(
			contentSource("entry-missing", "draft_overlay", {
				lastAttemptedAt: "2026-01-01T00:00:01.000Z",
				lastErrorCode: "DRAFT_REVISION_INVALID",
			}),
			null,
		);

		expect(attempted.attempted).toBe(true);
		expect(attempted.source).toBeNull();
		expect(await repo.findSource("content:posts:entry-missing:draft_overlay")).toEqual(
			expect.objectContaining({
				sourceCompleteness: "failed",
				lastErrorCode: "DRAFT_REVISION_INVALID",
			}),
		);
	});

	it("supports empty replacement while preserving the source row", async () => {
		const first = await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-old"),
		]);
		const second = await repo.replaceSource(contentSource("entry1", "columns"), []);

		expect(second.currentGeneration).not.toBe(first.currentGeneration);
		expect(await repo.findSource("content:posts:entry1:columns")).toEqual(
			expect.objectContaining({ currentGeneration: second.currentGeneration }),
		);
		expect(await repo.findCurrentUsageByMediaId("media-old")).toEqual([]);
	});

	it("deletes a single source and its occurrences", async () => {
		await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-live"),
		]);
		await repo.replaceSource(contentSource("entry1", "draft_overlay"), [
			occurrence("hero", "media-draft"),
		]);

		expect(await repo.deleteSource("content:posts:entry1:columns")).toBe(1);
		expect(await repo.findSource("content:posts:entry1:columns")).toBeNull();
		expect(await repo.findCurrentUsageByMediaId("media-live")).toEqual([]);
		expect(await repo.findCurrentUsageByMediaId("media-draft")).toHaveLength(1);
	});

	it("deletes all content sources for one collection and content id", async () => {
		await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-live"),
		]);
		await repo.replaceSource(contentSource("entry1", "draft_overlay"), [
			occurrence("hero", "media-draft"),
		]);
		await repo.replaceSource(contentSource("entry2", "columns"), [
			occurrence("hero", "media-other"),
		]);
		await repo.replaceSource(contentSource("entry1", "columns", { collectionSlug: "pages" }), [
			occurrence("hero", "media-page"),
		]);

		expect(await repo.deleteContentSources("posts", "entry1")).toBe(2);
		expect(await repo.findCurrentUsageByMediaId("media-live")).toEqual([]);
		expect(await repo.findCurrentUsageByMediaId("media-draft")).toEqual([]);
		expect(await repo.findCurrentUsageByMediaId("media-other")).toHaveLength(1);
		expect(await repo.findCurrentUsageByMediaId("media-page")).toHaveLength(1);
	});

	it("keeps current usage intact when source deletion fails without transactions", async () => {
		await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-live"),
		]);
		await installSourceDeleteFailureTrigger(ctx);
		vi.resetModules();
		const { MediaUsageRepository: D1LikeMediaUsageRepository } =
			await import("../../../src/database/repositories/media-usage.js");
		const d1LikeRepo = new D1LikeMediaUsageRepository(withoutTransactions(ctx.db));

		await expect(d1LikeRepo.deleteContentSources("posts", "entry1")).rejects.toThrow(
			"source delete failed",
		);

		expect(await repo.findSource("content:posts:entry1:columns")).not.toBeNull();
		expect(await repo.findCurrentUsageByMediaId("media-live")).toHaveLength(1);
	});

	it("deletes content sources by collection", async () => {
		await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-live"),
		]);
		await repo.replaceSource(contentSource("entry2", "draft_overlay"), [
			occurrence("hero", "media-draft"),
		]);
		await repo.replaceSource(contentSource("entry1", "columns", { collectionSlug: "pages" }), [
			occurrence("hero", "media-page"),
		]);

		expect(await repo.deleteCollectionSources("posts")).toBe(2);
		expect(await repo.findCurrentUsageByMediaId("media-live")).toEqual([]);
		expect(await repo.findCurrentUsageByMediaId("media-draft")).toEqual([]);
		expect(await repo.findCurrentUsageByMediaId("media-page")).toHaveLength(1);
	});

	it("deletes specific source keys in D1-safe batches", async () => {
		await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-live"),
		]);
		await repo.replaceSource(contentSource("entry1", "draft_overlay"), [
			occurrence("hero", "media-draft"),
		]);
		await repo.replaceSource(contentSource("entry2", "columns"), [
			occurrence("hero", "media-other"),
		]);

		expect(
			await repo.deleteSources([
				"content:posts:entry1:columns",
				"content:posts:entry1:draft_overlay",
				"content:posts:entry1:columns",
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
		await repo.replaceSource(contentSource("entry1", "columns"), [
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
				source: expect.objectContaining({ sourceKey: "content:posts:entry1:columns" }),
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
	it("keeps columns and draft overlay source keys separate for the same content", async () => {
		await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-shared"),
		]);
		await repo.replaceSource(contentSource("entry1", "draft_overlay"), [
			occurrence("draftHero", "media-shared", { fieldPath: "draftHero" }),
		]);

		const usage = await repo.findCurrentUsageByMediaId("media-shared");

		expect(usage.map((row) => row.source.sourceKey)).toEqual([
			"content:posts:entry1:columns",
			"content:posts:entry1:draft_overlay",
		]);
		expect(usage.map((row) => row.source.sourceVariant)).toEqual(["columns", "draft_overlay"]);
	});

	it("paginates current media usage by occurrence id", async () => {
		await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-shared"),
			occurrence("body", "media-shared"),
		]);
		await repo.replaceSource(contentSource("entry2", "columns"), [
			occurrence("hero", "media-shared"),
		]);

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
		await repo.replaceSource(contentSource("entry1", "columns"), [
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

	it("begins repair status with a cursor run token and zeroed counts", async () => {
		await repo.upsertIndexStatus({
			adapterId: "content-media",
			scopeType: "collection",
			scopeKey: "posts",
			status: "partial",
			startedAt: "2026-01-01T00:00:00.000Z",
			completedAt: "2026-01-01T00:00:02.000Z",
			cursor: "old-cursor",
			indexedSourceCount: 12,
			failedSourceCount: 2,
			lastErrorCode: "OLD_ERROR",
		});

		const running = await repo.beginIndexStatusRepair({
			adapterId: "content-media",
			scopeType: "collection",
			scopeKey: "posts",
			runToken: "repair-run-1",
			schemaVersion: 5,
			startedAt: "2026-01-02T00:00:00.000Z",
			updatedAt: "2026-01-02T00:00:01.000Z",
		});

		expect(running).toEqual(
			expect.objectContaining({
				status: "running",
				schemaVersion: 5,
				startedAt: "2026-01-02T00:00:00.000Z",
				completedAt: null,
				cursor: "repair-run-1",
				indexedSourceCount: 0,
				failedSourceCount: 0,
				lastErrorCode: null,
				updatedAt: "2026-01-02T00:00:01.000Z",
			}),
		);
	});

	it("finalizes repair status only when status and run token still match", async () => {
		await repo.beginIndexStatusRepair({
			adapterId: "content-media",
			scopeType: "collection",
			scopeKey: "posts",
			runToken: "repair-run-1",
			startedAt: "2026-01-01T00:00:00.000Z",
		});

		const finalized = await repo.finalizeIndexStatusRepairIfRunning({
			adapterId: "content-media",
			scopeType: "collection",
			scopeKey: "posts",
			runToken: "repair-run-1",
			status: "complete",
			schemaVersion: 4,
			completedAt: "2026-01-01T00:00:02.000Z",
			indexedSourceCount: 3,
			failedSourceCount: 0,
			updatedAt: "2026-01-01T00:00:03.000Z",
		});

		expect(finalized.finalized).toBe(true);
		expect(finalized.status).toEqual(
			expect.objectContaining({
				status: "complete",
				schemaVersion: 4,
				startedAt: "2026-01-01T00:00:00.000Z",
				completedAt: "2026-01-01T00:00:02.000Z",
				cursor: null,
				indexedSourceCount: 3,
				failedSourceCount: 0,
				lastErrorCode: null,
				updatedAt: "2026-01-01T00:00:03.000Z",
			}),
		);
	});

	it("does not finalize repair status after a stale mark wins the race", async () => {
		await repo.beginIndexStatusRepair({
			adapterId: "content-media",
			scopeType: "collection",
			scopeKey: "posts",
			runToken: "repair-run-1",
			startedAt: "2026-01-01T00:00:00.000Z",
		});
		await repo.upsertIndexStatus({
			adapterId: "content-media",
			scopeType: "collection",
			scopeKey: "posts",
			status: "stale",
			startedAt: "2026-01-01T00:00:00.000Z",
			cursor: "repair-run-1",
			lastErrorCode: "CONTENT_USAGE_STALE",
			updatedAt: "2026-01-01T00:00:01.000Z",
		});

		const stale = await repo.finalizeIndexStatusRepairIfRunning({
			adapterId: "content-media",
			scopeType: "collection",
			scopeKey: "posts",
			runToken: "repair-run-1",
			status: "complete",
			completedAt: "2026-01-01T00:00:02.000Z",
			indexedSourceCount: 3,
		});

		expect(stale.finalized).toBe(false);
		expect(stale.status).toEqual(
			expect.objectContaining({
				status: "stale",
				cursor: "repair-run-1",
				lastErrorCode: "CONTENT_USAGE_STALE",
			}),
		);
	});

	it("does not finalize repair status after a newer running repair wins the race", async () => {
		await repo.beginIndexStatusRepair({
			adapterId: "content-media",
			scopeType: "collection",
			scopeKey: "posts",
			runToken: "repair-run-1",
			startedAt: "2026-01-01T00:00:00.000Z",
		});
		await repo.beginIndexStatusRepair({
			adapterId: "content-media",
			scopeType: "collection",
			scopeKey: "posts",
			runToken: "repair-run-2",
			startedAt: "2026-01-01T00:00:01.000Z",
		});

		const stale = await repo.finalizeIndexStatusRepairIfRunning({
			adapterId: "content-media",
			scopeType: "collection",
			scopeKey: "posts",
			runToken: "repair-run-1",
			status: "complete",
			completedAt: "2026-01-01T00:00:02.000Z",
			indexedSourceCount: 3,
		});

		expect(stale.finalized).toBe(false);
		expect(stale.status).toEqual(
			expect.objectContaining({
				status: "running",
				startedAt: "2026-01-01T00:00:01.000Z",
				cursor: "repair-run-2",
			}),
		);
	});

	it("replaces more occurrences than one D1 insert batch", async () => {
		const occurrences = Array.from({ length: SQL_BATCH_SIZE + 7 }, (_, index) =>
			occurrence(`gallery-${index}`, `media-${index}`, {
				fieldPath: `gallery[${index}].image`,
			}),
		);
		const source = await repo.replaceSource(contentSource("entry1", "draft_overlay"), occurrences);
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
	variant: MediaUsageContentSourceVariant,
	overrides: Partial<Parameters<MediaUsageRepository["replaceSource"]>[0]> = {},
): Parameters<MediaUsageRepository["replaceSource"]>[0] {
	const collectionSlug = overrides.collectionSlug ?? "posts";
	return {
		sourceKey: buildContentMediaUsageSourceKey({
			collectionSlug,
			contentId,
			sourceVariant: variant,
		}),
		sourceType: "content",
		collectionSlug,
		contentId,
		sourceVariant: variant,
		locale: "en",
		translationGroup: `tg-${contentId}`,
		contentSlug: "hello-world",
		contentTitle: "Hello World",
		contentStatus: variant === "columns" ? "published" : "draft",
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

function withoutTransactions(db: DialectTestContext["db"]): DialectTestContext["db"] {
	return new Proxy(db, {
		get(target, property, receiver) {
			if (property === "transaction") {
				return () => ({
					execute: async () => {
						throw new Error("transactions are not supported");
					},
				});
			}

			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as DialectTestContext["db"];
}

async function installSourceDeleteFailureTrigger(ctx: DialectTestContext): Promise<void> {
	if (ctx.dialect === "postgres") {
		await sql`
			CREATE FUNCTION media_usage_source_delete_failure()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				RAISE EXCEPTION 'source delete failed';
			END;
			$$
		`.execute(ctx.db);
		await sql`
			CREATE TRIGGER media_usage_source_delete_failure
			BEFORE DELETE ON _emdash_media_usage_sources
			FOR EACH ROW
			EXECUTE FUNCTION media_usage_source_delete_failure()
		`.execute(ctx.db);
		return;
	}

	await sql`
		CREATE TRIGGER media_usage_source_delete_failure
		BEFORE DELETE ON _emdash_media_usage_sources
		BEGIN
			SELECT RAISE(ABORT, 'source delete failed');
		END
	`.execute(ctx.db);
}
