/**
 * Maintenance sweep for media-usage generations.
 *
 * Every content save writes a fresh generation of occurrence rows and leaves
 * the superseded generation behind; reads join on current_generation, so
 * stale rows are dead weight that grows one generation per save. The sweep
 * composes the repository GC methods behind a safety window and runs from
 * runSystemCleanup.
 */

import { afterEach, beforeEach, expect, it } from "vitest";

import { runSystemCleanup } from "../../../src/cleanup.js";
import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import { cleanupMediaUsageGenerations } from "../../../src/media/usage/gc.js";
import {
	buildContentMediaUsageSourceKey,
	type MediaUsageContentSourceVariant,
} from "../../../src/media/usage/source-key.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media-usage GC sweep", (dialect) => {
	let ctx: DialectTestContext;
	let repo: MediaUsageRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		repo = new MediaUsageRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function contentSource(
		contentId: string,
		variant: MediaUsageContentSourceVariant,
	): Parameters<MediaUsageRepository["replaceSource"]>[0] {
		return {
			sourceKey: buildContentMediaUsageSourceKey({
				collectionSlug: "posts",
				contentId,
				sourceVariant: variant,
			}),
			sourceType: "content",
			collectionSlug: "posts",
			contentId,
			sourceVariant: variant,
			locale: "en",
			translationGroup: `tg-${contentId}`,
			contentSlug: "hello-world",
			contentTitle: "Hello World",
			contentStatus: "published",
			contentScheduledAt: null,
			contentDeletedAt: null,
		};
	}

	function occurrence(
		fieldSlug: string,
		mediaId: string,
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
		};
	}

	it("removes superseded generations after repeated saves, keeping current usage", async () => {
		const first = await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-old"),
			occurrence("body", "media-old-2"),
		]);
		const second = await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-new"),
		]);

		// Age the superseded rows past the sweep's safety window.
		await ctx.db
			.updateTable("_emdash_media_usage")
			.set({ created_at: "2026-01-01T00:00:00.000Z" })
			.where("generation", "=", first.currentGeneration)
			.execute();

		const result = await cleanupMediaUsageGenerations(ctx.db);

		expect(result.staleGenerations).toBe(2);
		expect(result.abandonedGenerations).toBe(0);
		expect(result.orphanOccurrences).toBe(0);

		const remaining = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select(["generation", "media_id"])
			.execute();
		expect(remaining).toEqual([{ generation: second.currentGeneration, media_id: "media-new" }]);
		expect(await repo.findCurrentUsageByMediaId("media-new")).toHaveLength(1);
	});

	it("leaves superseded rows inside the safety window untouched", async () => {
		await repo.replaceSource(contentSource("entry1", "columns"), [occurrence("hero", "media-old")]);
		await repo.replaceSource(contentSource("entry1", "columns"), [occurrence("hero", "media-new")]);

		const result = await cleanupMediaUsageGenerations(ctx.db);

		expect(result.staleGenerations).toBe(0);
		const rows = await ctx.db.selectFrom("_emdash_media_usage").select("id").execute();
		expect(rows).toHaveLength(2);
	});

	it("runs as part of the periodic system cleanup", async () => {
		const first = await repo.replaceSource(contentSource("entry1", "columns"), [
			occurrence("hero", "media-old"),
		]);
		await repo.replaceSource(contentSource("entry1", "columns"), [occurrence("hero", "media-new")]);
		await ctx.db
			.updateTable("_emdash_media_usage")
			.set({ created_at: "2026-01-01T00:00:00.000Z" })
			.where("generation", "=", first.currentGeneration)
			.execute();

		const result = await runSystemCleanup(ctx.db);

		expect(result.mediaUsageStaleGenerations).toBe(1);
		const rows = await ctx.db.selectFrom("_emdash_media_usage").select("generation").execute();
		expect(rows.map((r) => r.generation)).not.toContain(first.currentGeneration);
	});
});
