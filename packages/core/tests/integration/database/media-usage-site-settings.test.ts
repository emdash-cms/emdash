import { afterEach, beforeEach, expect, it } from "vitest";

import {
	handleMediaUsageDetails,
	handleMediaUsageSummaries,
} from "../../../src/api/handlers/media-usage.js";
import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import {
	CONTENT_MEDIA_USAGE_ADAPTER_ID,
	CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
} from "../../../src/media/usage/content-refresh.js";
import { buildContentMediaUsageSourceKey } from "../../../src/media/usage/source-key.js";
import { CONTENT_SOURCE_SCHEMA_VERSION } from "../../../src/media/usage/types.js";
import { setSiteSettings } from "../../../src/settings/index.js";
import { SETTING_MEDIA_REFERENCE_PATHS } from "../../../src/transfer/format/settings.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media usage from site settings", (dialect) => {
	let ctx: DialectTestContext;
	let favicon: string;
	let banner: string;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const media = new MediaRepository(ctx.db);
		favicon = (
			await media.create({
				filename: "icon.svg",
				mimeType: "image/svg+xml",
				storageKey: "icon.svg",
			})
		).id;
		banner = (
			await media.create({
				filename: "banner.png",
				mimeType: "image/png",
				storageKey: "banner.png",
			})
		).id;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function siteSettingsUsing(mediaId: string) {
		const result = await handleMediaUsageDetails(ctx.db, mediaId, {});
		if (!result.success) throw new Error(result.error.message);
		return result.data.siteSettings;
	}

	async function usageCount(mediaId: string) {
		const result = await handleMediaUsageSummaries(ctx.db, [mediaId], { includeCount: true });
		if (!result.success) throw new Error(result.error.message);
		return result.data[mediaId]?.count;
	}

	it("lists every site setting that selects the media item", async () => {
		await setSiteSettings(
			{
				logo: { mediaId: favicon, alt: "Logo" },
				favicon: { mediaId: favicon },
				seo: { titleSeparator: " | ", defaultOgImage: { mediaId: banner } },
			},
			ctx.db,
		);

		expect(await siteSettingsUsing(favicon)).toEqual([{ setting: "logo" }, { setting: "favicon" }]);
		expect(await siteSettingsUsing(banner)).toEqual([{ setting: "seo.defaultOgImage" }]);
	});

	it("follows a replaced and then removed setting", async () => {
		await setSiteSettings({ favicon: { mediaId: favicon } }, ctx.db);
		expect(await siteSettingsUsing(favicon)).toEqual([{ setting: "favicon" }]);

		await setSiteSettings({ favicon: { mediaId: banner } }, ctx.db);
		expect(await siteSettingsUsing(favicon)).toEqual([]);
		expect(await siteSettingsUsing(banner)).toEqual([{ setting: "favicon" }]);

		await setSiteSettings({ favicon: null, seo: { defaultOgImage: null } }, ctx.db);
		expect(await siteSettingsUsing(banner)).toEqual([]);
	});

	it("reads settings written directly to the options table", async () => {
		await new OptionsRepository(ctx.db).set("site:favicon", { mediaId: favicon });

		expect(await siteSettingsUsing(favicon)).toEqual([{ setting: "favicon" }]);
	});

	it("ignores settings values that do not hold a media reference", async () => {
		const options = new OptionsRepository(ctx.db);
		await options.set("site:logo", favicon);
		await options.set("site:favicon", { mediaId: 42 });
		await options.set("site:seo", { defaultOgImage: favicon });

		expect(await siteSettingsUsing(favicon)).toEqual([]);
	});

	it("reports every media reference the site transfer format declares", async () => {
		const media = new MediaRepository(ctx.db);
		const options = new OptionsRepository(ctx.db);
		const referencedIds: string[] = [];
		for (const [name, paths = []] of Object.entries(SETTING_MEDIA_REFERENCE_PATHS)) {
			const value = {};
			for (const path of paths) {
				const { id } = await media.create({
					filename: `${name}.png`,
					mimeType: "image/png",
					storageKey: `${name}-${referencedIds.length}.png`,
				});
				referencedIds.push(id);
				Object.assign(
					value,
					path.reduceRight<unknown>((inner, segment) => ({ [segment]: inner }), id),
				);
			}
			await options.set(name, value);
		}

		const reported: string[] = [];
		for (const mediaId of referencedIds) {
			const settings = await siteSettingsUsing(mediaId);
			expect(settings).toHaveLength(1);
			reported.push(...settings.map(({ setting }) => setting));
		}
		expect(reported.toSorted()).toEqual(["favicon", "logo", "seo.defaultOgImage"]);
	});

	it("counts site settings alongside indexed content entries", async () => {
		await setSiteSettings({ favicon: { mediaId: favicon } }, ctx.db);
		expect(await usageCount(favicon)).toBe(1);

		await ctx.db
			.insertInto("_emdash_collections")
			.values({ id: "collection-posts", slug: "posts", label: "Posts", has_seo: 0 })
			.execute();
		const usage = new MediaUsageRepository(ctx.db);
		await usage.upsertIndexStatus({
			adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
			scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
			scopeKey: "posts",
			status: "complete",
			schemaVersion: CONTENT_SOURCE_SCHEMA_VERSION,
		});
		await usage.replaceSource(
			{
				sourceKey: buildContentMediaUsageSourceKey({
					collectionSlug: "posts",
					contentId: "entry-1",
					sourceVariant: "columns",
				}),
				sourceType: "content",
				collectionSlug: "posts",
				contentId: "entry-1",
				sourceVariant: "columns",
				contentStatus: "published",
			},
			[
				{
					fieldSlug: "hero",
					fieldPath: "hero",
					referenceType: "image_field",
					mediaId: favicon,
					provider: "local",
					providerAssetId: favicon,
				},
			],
		);

		expect(await usageCount(favicon)).toBe(2);
		expect(await usageCount(banner)).toBe(0);
	});
});
