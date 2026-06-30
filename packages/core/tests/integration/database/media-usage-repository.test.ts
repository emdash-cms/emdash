import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
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

	it("replaces current usage for one content source", async () => {
		await repo.replaceContentUsage({
			collection: "posts",
			contentId: "entry1",
			contentSlug: "hello",
			locale: "en",
			translationGroup: "entry1",
			contentStatus: "draft",
			state: "live",
			references: [localImageRef("media_a")],
		});

		expect(await repo.findCurrentByMediaId("media_a")).toHaveLength(1);

		await repo.replaceContentUsage({
			collection: "posts",
			contentId: "entry1",
			contentSlug: "hello",
			locale: "en",
			translationGroup: "entry1",
			contentStatus: "draft",
			state: "live",
			references: [localImageRef("media_b")],
		});

		expect(await repo.findCurrentByMediaId("media_a")).toHaveLength(0);
		const mediaB = await repo.findCurrentByMediaId("media_b");
		expect(mediaB).toHaveLength(1);
		expect(mediaB[0]?.fieldPath).toBe("hero");
		expect(mediaB[0]?.provider).toBe("local");
		expect(mediaB[0]?.providerAssetId).toBe("media_b");
	});

	it("indexes structured provider asset references", async () => {
		await repo.replaceContentUsage({
			collection: "posts",
			contentId: "entry1",
			contentSlug: "hello",
			state: "draft",
			references: [
				{
					mediaId: null,
					provider: "mux",
					providerAssetId: "asset_1",
					mediaKind: "video",
					mimeType: "video/mp4",
					referenceType: "file_field",
					fieldPath: "trailer",
				},
			],
		});

		expect(await repo.findCurrentByMediaId("asset_1")).toHaveLength(0);
		const usage = await repo.findCurrentByProviderAsset("mux", "asset_1");
		expect(usage).toHaveLength(1);
		expect(usage[0]?.mediaId).toBeNull();
		expect(usage[0]?.mediaKind).toBe("video");
		expect(usage[0]?.mimeType).toBe("video/mp4");
	});

	it("keeps live and draft sources separate", async () => {
		await repo.replaceContentUsage({
			collection: "posts",
			contentId: "entry1",
			contentSlug: "hello",
			state: "live",
			references: [localImageRef("media_live")],
		});
		await repo.replaceContentUsage({
			collection: "posts",
			contentId: "entry1",
			contentSlug: "hello",
			state: "draft",
			references: [localImageRef("media_draft")],
		});

		expect((await repo.findCurrentByMediaId("media_live"))[0]?.state).toBe("live");
		expect((await repo.findCurrentByMediaId("media_draft"))[0]?.state).toBe("draft");
	});

	it("empty replacements clear current usage for that source", async () => {
		await repo.replaceContentUsage({
			collection: "posts",
			contentId: "entry1",
			state: "live",
			references: [localImageRef("media_a")],
		});

		await repo.replaceContentUsage({
			collection: "posts",
			contentId: "entry1",
			state: "live",
			references: [],
		});

		expect(await repo.findCurrentByMediaId("media_a")).toHaveLength(0);
	});

	it("stale generation cleanup preserves the source's current generation", async () => {
		const sourceKey = MediaUsageRepository.contentSourceKey("posts", "entry1", "live");
		await ctx.db
			.insertInto("_emdash_media_usage_sources")
			.values({
				source_key: sourceKey,
				source_type: "content",
				collection: "posts",
				content_id: "entry1",
				content_slug: "hello",
				state: "live",
				current_generation: "gen_new",
			})
			.execute();
		await ctx.db
			.insertInto("_emdash_media_usage")
			.values([
				{
					id: "usage_old",
					source_key: sourceKey,
					generation: "gen_old",
					media_id: "media_old",
					provider: "local",
					provider_asset_id: "media_old",
					reference_type: "image_field",
					field_path: "hero",
				},
				{
					id: "usage_new",
					source_key: sourceKey,
					generation: "gen_new",
					media_id: "media_new",
					provider: "local",
					provider_asset_id: "media_new",
					reference_type: "image_field",
					field_path: "hero",
				},
			])
			.execute();

		await repo.deleteStaleGenerationsForSource(sourceKey);

		const staleRows = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select("id")
			.where("id", "=", "usage_old")
			.execute();
		expect(staleRows).toHaveLength(0);
		expect(await repo.findCurrentByMediaId("media_new")).toHaveLength(1);
	});
});

function localImageRef(mediaId: string) {
	return {
		mediaId,
		provider: "local",
		providerAssetId: mediaId,
		mediaKind: "image" as const,
		mimeType: null,
		referenceType: "image_field" as const,
		fieldPath: "hero",
	};
}
