import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { rewriteUrls } from "../../../src/astro/routes/api/import/wordpress/rewrite-urls.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import {
	CONTENT_MEDIA_USAGE_ADAPTER_ID,
	CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
	markContentMediaUsageCollectionStaleSafely,
} from "../../../src/media/usage/content-refresh.js";
import {
	buildContentMediaUsageSourceKey,
	type MediaUsageContentSourceVariant,
} from "../../../src/media/usage/source-key.js";
import { createContentAccessWithWrite } from "../../../src/plugins/context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { applySeed } from "../../../src/seed/apply.js";
import type { SeedFile } from "../../../src/seed/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media usage stale marking for bypass writes", (dialect) => {
	let ctx: DialectTestContext;
	let registry: SchemaRegistry;
	let usageRepo: MediaUsageRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		registry = new SchemaRegistry(ctx.db);
		usageRepo = new MediaUsageRepository(ctx.db);
		await createCollectionWithFields("posts");
		await createCollectionWithFields("pages");
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("marks touched collections stale after seed content writes", async () => {
		await markComplete("posts");
		const seed: SeedFile = {
			version: "1",
			content: {
				posts: [
					{
						id: "seed-post",
						slug: "seed-post",
						data: {
							title: "Seed Post",
							hero: mediaRef("media-seed"),
						},
					},
				],
			},
		};

		await applySeed(ctx.db, seed, { includeContent: true });

		await expectCollectionStatus("posts", "stale");
	});

	it("marks seed-touched collections stale even when a later content entry fails", async () => {
		await markComplete("posts");
		const seed: SeedFile = {
			version: "1",
			content: {
				posts: [
					{
						id: "seed-created-before-failure",
						slug: "duplicate-seed-slug",
						data: { title: "Created Before Failure" },
					},
					{
						id: "seed-conflict",
						slug: "duplicate-seed-slug",
						data: { title: "Conflict" },
					},
				],
			},
		};

		await expect(
			applySeed(ctx.db, seed, { includeContent: true, onConflict: "error" }),
		).rejects.toThrow(/Conflict: content/);

		await expectCollectionStatus("posts", "stale");
	});

	it("marks collections stale after plugin content direct writes", async () => {
		await markComplete("posts");
		const content = createContentAccessWithWrite(ctx.db);

		await content.create("posts", {
			title: "Plugin Post",
			hero: mediaRef("media-plugin-create"),
		});

		await expectCollectionStatus("posts", "stale");
		await markComplete("posts");

		const repo = new ContentRepository(ctx.db);
		const item = await repo.create({
			type: "posts",
			slug: "plugin-update",
			data: { title: "Plugin Update", hero: mediaRef("media-plugin-old") },
		});

		await content.update("posts", item.id, { hero: mediaRef("media-plugin-new") });

		await expectCollectionStatus("posts", "stale");
		await markComplete("posts");

		expect(await content.delete("posts", item.id)).toBe(true);

		await expectCollectionStatus("posts", "stale");
	});

	it("marks collections stale after schema field mutations", async () => {
		await markComplete("posts");

		await registry.createField("posts", { slug: "deck", label: "Deck", type: "string" });

		await expectCollectionStatus("posts", "stale");
		await markComplete("posts");

		await registry.updateField("posts", "hero", { label: "Hero Image" });

		await expectCollectionStatus("posts", "stale");
		await markComplete("posts");

		await registry.deleteField("posts", "deck");

		await expectCollectionStatus("posts", "stale");
	});

	it("marks registered orphaned tables stale", async () => {
		await sql`CREATE TABLE ec_orphan_posts (id text primary key)`.execute(ctx.db);

		await registry.registerOrphanedTable("orphan_posts");

		await expectCollectionStatus("orphan_posts", "stale");
	});

	it("deletes collection usage sources after collection deletion", async () => {
		await markComplete("posts");
		await usageRepo.replaceSource(contentSource("posts", "entry-1", "columns"), [
			occurrence("hero", "media-collection-delete"),
		]);
		expect(await usageRepo.findSource(sourceKey("posts", "entry-1", "columns"))).not.toBeNull();

		await registry.deleteCollection("posts", { force: true });

		expect(await usageRepo.findSource(sourceKey("posts", "entry-1", "columns"))).toBeNull();
		expect(await usageRepo.findCurrentUsageByMediaId("media-collection-delete")).toEqual([]);
		expect(await findCollectionStatus("posts")).toBeNull();
	});

	it("retries failed WordPress rewrite stale marks once after the rewrite pass", async () => {
		const repo = new ContentRepository(ctx.db);
		const oldUrl = "https://example.com/wp-content/uploads/2026/01/hero.jpg";
		await repo.create({
			type: "posts",
			slug: "rewrite-retry-post",
			data: { title: "Rewrite Retry Post", body: `<img src="${oldUrl}">` },
		});
		await markComplete("posts");
		let attempts = 0;

		const result = await rewriteUrls(
			ctx.db,
			{ [oldUrl]: "/_emdash/media/file/imported/hero.jpg" },
			() => undefined,
			["posts"],
			async (db, collectionSlug, lastErrorCode) => {
				attempts++;
				if (attempts === 1) return false;
				return markContentMediaUsageCollectionStaleSafely(db, collectionSlug, lastErrorCode);
			},
		);

		expect(result.byCollection).toEqual({ posts: 1 });
		expect(attempts).toBe(2);
		await expectCollectionStatus("posts", "stale");
	});

	it("marks only rewritten WordPress URL collections stale", async () => {
		const repo = new ContentRepository(ctx.db);
		const oldUrl = "https://example.com/wp-content/uploads/2026/01/hero.jpg";
		await repo.create({
			type: "posts",
			slug: "rewrite-post",
			data: { title: "Rewrite Post", body: `<img src="${oldUrl}">` },
		});
		await repo.create({
			type: "pages",
			slug: "clean-page",
			data: { title: "Clean Page", body: "No matching media URL" },
		});
		await markComplete("posts");
		await markComplete("pages");

		const result = await rewriteUrls(
			ctx.db,
			{ [oldUrl]: "/_emdash/media/file/imported/hero.jpg" },
			() => undefined,
		);

		expect(result.byCollection).toEqual({ posts: 1 });
		await expectCollectionStatus("posts", "stale");
		await expectCollectionStatus("pages", "complete");
	});

	it("marks earlier WordPress rewrite collections stale when a later collection fails", async () => {
		const repo = new ContentRepository(ctx.db);
		const oldUrl = "https://example.com/wp-content/uploads/2026/01/hero.jpg";
		await repo.create({
			type: "posts",
			slug: "rewrite-before-error",
			data: { title: "Rewrite Before Error", body: `<img src="${oldUrl}">` },
		});
		await registry.createCollection({ slug: "zz_broken", label: "Broken" });
		const broken = await registry.getCollection("zz_broken");
		expect(broken).not.toBeNull();
		await ctx.db
			.insertInto("_emdash_fields")
			.values({
				id: "broken_field",
				collection_id: broken!.id,
				slug: "bad_repeater",
				label: "Bad Repeater",
				type: "repeater",
				column_type: "JSON",
				required: 0,
				unique: 0,
				default_value: null,
				validation: "{",
				widget: null,
				options: null,
				sort_order: 0,
				searchable: 0,
				translatable: 1,
			})
			.execute();
		await markComplete("posts");
		let staleMarkAttempts = 0;

		await expect(
			rewriteUrls(
				ctx.db,
				{ [oldUrl]: "/_emdash/media/file/imported/hero.jpg" },
				() => undefined,
				["posts", "zz_broken"],
				async (db, collectionSlug, lastErrorCode) => {
					if (collectionSlug !== "posts") {
						return markContentMediaUsageCollectionStaleSafely(db, collectionSlug, lastErrorCode);
					}
					staleMarkAttempts++;
					if (staleMarkAttempts === 1) return false;
					return markContentMediaUsageCollectionStaleSafely(db, collectionSlug, lastErrorCode);
				},
			),
		).rejects.toThrow();

		expect(staleMarkAttempts).toBe(2);
		await expectCollectionStatus("posts", "stale");
	});

	async function createCollectionWithFields(slug: string) {
		await registry.createCollection({ slug, label: slug });
		await registry.createField(slug, { slug: "title", label: "Title", type: "string" });
		await registry.createField(slug, { slug: "body", label: "Body", type: "text" });
		await registry.createField(slug, { slug: "hero", label: "Hero", type: "image" });
	}

	async function markComplete(collectionSlug: string) {
		await usageRepo.upsertIndexStatus({
			adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
			scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
			scopeKey: collectionSlug,
			status: "complete",
			schemaVersion: 1,
			indexedSourceCount: 1,
			failedSourceCount: 0,
		});
	}

	async function expectCollectionStatus(collectionSlug: string, status: string) {
		await expect(findCollectionStatus(collectionSlug)).resolves.toEqual(
			expect.objectContaining({ status }),
		);
	}

	async function findCollectionStatus(collectionSlug: string) {
		return usageRepo.findIndexStatus({
			adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
			scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
			scopeKey: collectionSlug,
		});
	}
});

function mediaRef(id: string): Record<string, unknown> {
	return {
		id,
		provider: "local",
		mimeType: "image/webp",
		width: 100,
		height: 100,
	};
}

function sourceKey(
	collectionSlug: string,
	contentId: string,
	sourceVariant: MediaUsageContentSourceVariant,
): string {
	return buildContentMediaUsageSourceKey({ collectionSlug, contentId, sourceVariant });
}

function contentSource(
	collectionSlug: string,
	contentId: string,
	sourceVariant: MediaUsageContentSourceVariant,
) {
	return {
		sourceKey: sourceKey(collectionSlug, contentId, sourceVariant),
		sourceType: "content",
		collectionSlug,
		contentId,
		sourceVariant,
		contentSlug: "hello-world",
		contentTitle: "Hello World",
		contentStatus: "published",
		schemaVersion: 1,
		sourceCompleteness: "complete" as const,
	};
}

function occurrence(fieldSlug: string, mediaId: string) {
	return {
		fieldSlug,
		fieldPath: fieldSlug,
		referenceType: "image_field" as const,
		mediaId,
		provider: "local",
		providerAssetId: mediaId,
		mediaKind: "image" as const,
		mimeType: "image/webp",
	};
}
