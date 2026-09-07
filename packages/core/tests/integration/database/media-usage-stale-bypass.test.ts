import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { rewriteUrls } from "../../../src/astro/routes/api/import/wordpress/rewrite-urls.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import { installMediaUsageCaptureTriggers } from "../../../src/media/usage/capture-triggers.js";
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

	it("requires reconciliation after active schema field mutations", async () => {
		const collectionId = await activateCollectionCapture("posts");

		await registry.createField("posts", { slug: "deck", label: "Deck", type: "string" });
		await expectSchemaReconciliation(collectionId, 2);

		await trustCurrentSchema(collectionId);
		await registry.updateField("posts", "deck", { type: "text" });
		await expectSchemaReconciliation(collectionId, 4);

		await trustCurrentSchema(collectionId);
		await registry.deleteField("posts", "deck");
		await expectSchemaReconciliation(collectionId, 6);

		expect(
			await usageRepo.recordIncrementalSuccess({ collectionId, collectionSlug: "posts" }),
		).toBe(true);
		await expectSchemaReconciliation(collectionId, 6);
	});

	it("keeps active coverage trusted when a field update makes no schema mutation", async () => {
		const collectionId = await activateCollectionCapture("posts");
		const statusBefore = await ctx.db
			.selectFrom("_emdash_media_usage_index_status")
			.select(["status", "reconciliation_required", "change_epoch", "capture_state"])
			.where("collection_id", "=", collectionId)
			.executeTakeFirstOrThrow();

		await registry.updateField("posts", "hero", {});
		await registry.updateField("posts", "hero", { indexed: false });
		await expect(registry.updateField("posts", "hero", { required: true })).rejects.toThrow(
			/manual content migration/,
		);

		await expect(
			ctx.db
				.selectFrom("_emdash_media_usage_index_status")
				.select(["status", "reconciliation_required", "change_epoch", "capture_state"])
				.where("collection_id", "=", collectionId)
				.executeTakeFirstOrThrow(),
		).resolves.toEqual(statusBefore);
	});

	it("does not mutate schema when active coverage cannot be invalidated", async () => {
		const collectionId = await activateCollectionCapture("posts");
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ capture_state: "installing" })
			.where("collection_id", "=", collectionId)
			.execute();

		await expect(
			registry.createField("posts", { slug: "blocked", label: "Blocked", type: "image" }),
		).rejects.toThrow();
		await expect(registry.getField("posts", "blocked")).resolves.toBeNull();
	});

	it.runIf(dialect === "sqlite")(
		"fences a repair that starts during an active schema mutation",
		async () => {
			const collectionId = await activateCollectionCapture("posts");
			const runToken = "schema-race-repair";
			await sql`
				CREATE TRIGGER begin_media_usage_repair_during_schema_change
				AFTER INSERT ON _emdash_fields
				WHEN NEW.slug = 'race_field'
				BEGIN
					UPDATE _emdash_media_usage_index_status
					SET status = 'running',
						started_at = '2026-08-09T00:00:00.000Z',
						completed_at = NULL,
						cursor = ${sql.lit(runToken)},
						reconciliation_required = 1
					WHERE collection_id = ${sql.lit(collectionId)};
				END
			`.execute(ctx.db);

			await registry.createField("posts", {
				slug: "race_field",
				label: "Race field",
				type: "image",
			});
			const finalized = await usageRepo.finalizeIndexStatusRepairAtEpoch({
				adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
				scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
				scopeKey: "posts",
				collectionId,
				runToken,
				startingEpoch: 1,
				status: "complete",
				schemaVersion: 1,
				indexedSourceCount: 0,
				failedSourceCount: 0,
				lastErrorCode: null,
			});

			expect(finalized.finalized).toBe(false);
			await expectSchemaReconciliation(collectionId, 2);
		},
	);

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

	async function activateCollectionCapture(collectionSlug: string): Promise<string> {
		const collection = await registry.getCollection(collectionSlug);
		if (!collection) throw new Error(`Expected ${collectionSlug} collection`);
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({
				collection_id: collection.id,
				status: "complete",
				completed_at: "2026-08-01T00:00:00.000Z",
				reconciliation_required: 0,
				capture_state: "installing",
			})
			.where("adapter_id", "=", CONTENT_MEDIA_USAGE_ADAPTER_ID)
			.where("scope_type", "=", CONTENT_MEDIA_USAGE_COLLECTION_SCOPE)
			.where("scope_key", "=", collectionSlug)
			.execute();
		await installMediaUsageCaptureTriggers(ctx.db, {
			collectionId: collection.id,
			collectionSlug,
		});
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ capture_state: "active" })
			.where("collection_id", "=", collection.id)
			.execute();
		await ctx.db
			.updateTable("_emdash_media_usage_activation")
			.set({ state: "active", activated_at: "2026-08-05T00:00:00.000Z" })
			.where("task_key", "=", "incremental_capture")
			.execute();
		return collection.id;
	}

	async function trustCurrentSchema(collectionId: string): Promise<void> {
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ status: "complete", reconciliation_required: 0 })
			.where("collection_id", "=", collectionId)
			.execute();
	}

	async function expectSchemaReconciliation(
		collectionId: string,
		changeEpoch: number,
	): Promise<void> {
		await expect(
			ctx.db
				.selectFrom("_emdash_media_usage_index_status")
				.select(["status", "reconciliation_required", "change_epoch"])
				.where("collection_id", "=", collectionId)
				.executeTakeFirstOrThrow(),
		).resolves.toEqual({
			status: "stale",
			reconciliation_required: 1,
			change_epoch: expect.toSatisfy((value) => Number(value) === changeEpoch),
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
