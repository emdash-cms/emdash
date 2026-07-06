import { sql } from "kysely";
import { ulid } from "ulidx";
import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import {
	CONTENT_MEDIA_USAGE_ADAPTER_ID,
	CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
} from "../../../src/media/usage/content-refresh.js";
import {
	repairContentMediaUsageCollection,
	scanContentMediaUsageCollection,
} from "../../../src/media/usage/content-repair.js";
import {
	buildContentMediaUsageSourceKey,
	type MediaUsageContentSourceVariant,
} from "../../../src/media/usage/source-key.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("content media usage repair", (dialect) => {
	let ctx: DialectTestContext;
	let registry: SchemaRegistry;
	let usageRepo: MediaUsageRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		registry = new SchemaRegistry(ctx.db);
		usageRepo = new MediaUsageRepository(ctx.db);

		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "hero", label: "Hero", type: "image" });
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("scans collection content IDs in deterministic order", async () => {
		const later = await insertPost(ctx, {
			id: "post_z",
			slug: "later",
			status: "published",
			data: { title: "Later" },
		});
		const earlier = await insertPost(ctx, {
			id: "post_a",
			slug: "earlier",
			status: "published",
			data: { title: "Earlier" },
		});

		const scan = await scanContentMediaUsageCollection(ctx.db, "posts");

		expect(scan).toEqual({ collectionSlug: "posts", contentIds: [earlier.id, later.id] });
	});

	it("repairs collection sources and finalizes complete coverage", async () => {
		const first = await insertPost(ctx, {
			slug: "first-post",
			status: "published",
			data: {
				title: "First Post",
				hero: { id: "media-first", provider: "local", mimeType: "image/webp" },
			},
		});
		const second = await insertPost(ctx, {
			slug: "second-post",
			status: "published",
			data: {
				title: "Second Post",
				hero: { id: "media-second", provider: "local", mimeType: "image/webp" },
			},
		});

		const result = await repairContentMediaUsageCollection(ctx.db, { collectionSlug: "posts" });

		expect(result).toEqual(
			expect.objectContaining({
				scope: {
					adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
					scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
					scopeKey: "posts",
				},
				status: "complete",
				indexedSourceCount: 2,
				failedSourceCount: 0,
				skippedSourceCount: 0,
				deletedSourceCount: 0,
				lastErrorCode: null,
				completedAt: expect.any(String),
			}),
		);
		expect(await usageRepo.findSource(sourceKey(first.id, "columns"))).toEqual(
			expect.objectContaining({ contentTitle: "First Post", sourceCompleteness: "complete" }),
		);
		expect(await usageRepo.findSource(sourceKey(second.id, "columns"))).toEqual(
			expect.objectContaining({ contentTitle: "Second Post", sourceCompleteness: "complete" }),
		);
		expect(await usageRepo.findCurrentUsageByMediaId("media-first")).toHaveLength(1);
		expect(await usageRepo.findCurrentUsageByMediaId("media-second")).toHaveLength(1);
		expect(
			await usageRepo.findIndexStatus({
				adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
				scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
				scopeKey: "posts",
			}),
		).toEqual(
			expect.objectContaining({
				status: "complete",
				cursor: null,
				indexedSourceCount: 2,
				failedSourceCount: 0,
				lastErrorCode: null,
			}),
		);
	});

	it("repairs empty collection scopes as complete", async () => {
		const result = await repairContentMediaUsageCollection(ctx.db, { collectionSlug: "posts" });

		expect(result).toEqual(
			expect.objectContaining({
				status: "complete",
				indexedSourceCount: 0,
				failedSourceCount: 0,
				skippedSourceCount: 0,
				deletedSourceCount: 0,
				lastErrorCode: null,
			}),
		);
		expect(
			await usageRepo.findIndexStatus({
				adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
				scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
				scopeKey: "posts",
			}),
		).toEqual(expect.objectContaining({ status: "complete", indexedSourceCount: 0 }));
	});

	it("does not mark empty collections complete when field discovery fails", async () => {
		await registry.createField("posts", { slug: "sections", label: "Sections", type: "repeater" });
		await ctx.db
			.updateTable("_emdash_fields")
			.set({ validation: "{" })
			.where("slug", "=", "sections")
			.execute();

		const result = await repairContentMediaUsageCollection(ctx.db, { collectionSlug: "posts" });

		expect(result).toEqual(
			expect.objectContaining({
				status: "failed",
				lastErrorCode: "INVALID_REPEATER_VALIDATION",
				indexedSourceCount: 0,
			}),
		);
		expect(
			await usageRepo.findIndexStatus({
				adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
				scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
				scopeKey: "posts",
			}),
		).toEqual(
			expect.objectContaining({
				status: "failed",
				lastErrorCode: "INVALID_REPEATER_VALIDATION",
			}),
		);
	});

	it("keeps per-source failures without trusted progress failed", async () => {
		const item = await insertPost(ctx, {
			id: "post_failed_source",
			slug: "failed-source-post",
			status: "published",
			data: {
				title: "Failed Source Post",
				hero: { id: "media-unindexed", provider: "local", mimeType: "image/webp" },
			},
		});
		await ctx.db
			.insertInto("revisions")
			.values({
				id: "mismatched_revision",
				collection: "pages",
				entry_id: item.id,
				data: JSON.stringify({ hero: { id: "media-draft", provider: "local" } }),
			})
			.execute();
		await sql`
			UPDATE ${sql.ref("ec_posts")}
			SET draft_revision_id = ${"mismatched_revision"}
			WHERE id = ${item.id}
		`.execute(ctx.db);

		const result = await repairContentMediaUsageCollection(ctx.db, { collectionSlug: "posts" });

		expect(result).toEqual(
			expect.objectContaining({
				status: "failed",
				indexedSourceCount: 0,
				failedSourceCount: 1,
				skippedSourceCount: 0,
				deletedSourceCount: 0,
				lastErrorCode: "DRAFT_REVISION_MISMATCH",
			}),
		);
		expect(await usageRepo.findSource(sourceKey(item.id, "columns"))).toBeNull();
		expect(await usageRepo.findSource(sourceKey(item.id, "draft_overlay"))).toEqual(
			expect.objectContaining({
				sourceCompleteness: "failed",
				lastErrorCode: "DRAFT_REVISION_MISMATCH",
			}),
		);
		expect(
			await usageRepo.findIndexStatus({
				adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
				scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
				scopeKey: "posts",
			}),
		).toEqual(
			expect.objectContaining({
				status: "failed",
				indexedSourceCount: 0,
				failedSourceCount: 1,
				lastErrorCode: "DRAFT_REVISION_MISMATCH",
			}),
		);
	});

	it("scans deleted content rows during repair", async () => {
		const deletedAt = "2026-01-01T00:00:00.000Z";
		const item = await insertPost(ctx, {
			slug: "trash-post",
			status: "published",
			deletedAt,
			data: {
				title: "Trash Post",
				hero: { id: "media-trash", provider: "local", mimeType: "image/webp" },
			},
		});

		const result = await repairContentMediaUsageCollection(ctx.db, { collectionSlug: "posts" });

		expect(result.status).toBe("complete");
		expect(result.indexedSourceCount).toBe(1);
		expect(await usageRepo.findSource(sourceKey(item.id, "columns"))).toEqual(
			expect.objectContaining({ contentDeletedAt: deletedAt }),
		);
		expect(await usageRepo.findCurrentUsageByMediaId("media-trash")).toHaveLength(1);
	});

	it("does not finalize complete when content IDs change during repair", async () => {
		await insertPost(ctx, {
			id: "post_existing",
			slug: "existing-post",
			status: "published",
			data: {
				title: "Existing Post",
				hero: { id: "media-first", provider: "local", mimeType: "image/webp" },
			},
		});
		await installConcurrentPostInsertTrigger(ctx);

		const result = await repairContentMediaUsageCollection(ctx.db, { collectionSlug: "posts" });

		expect(result).toEqual(
			expect.objectContaining({
				status: "partial",
				indexedSourceCount: 1,
				skippedSourceCount: 1,
				lastErrorCode: "CONTENT_USAGE_REPAIR_CONFLICT",
			}),
		);
		expect(await usageRepo.findSource(sourceKey("post_concurrent", "columns"))).toBeNull();
		expect(
			await usageRepo.findIndexStatus({
				adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
				scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
				scopeKey: "posts",
			}),
		).toEqual(
			expect.objectContaining({
				status: "partial",
				lastErrorCode: "CONTENT_USAGE_REPAIR_CONFLICT",
			}),
		);
	});

	it("reports skipped-only repair source conflicts as partial", async () => {
		await insertPost(ctx, {
			id: "post_conflict",
			slug: "conflicted-post",
			status: "published",
			data: {
				title: "Conflicted Post",
				hero: { id: "media-repair", provider: "local", mimeType: "image/webp" },
			},
		});
		await installFresherColumnsSourceDuringRepairTrigger(ctx);

		const result = await repairContentMediaUsageCollection(ctx.db, { collectionSlug: "posts" });

		expect(result).toEqual(
			expect.objectContaining({
				status: "partial",
				indexedSourceCount: 0,
				failedSourceCount: 0,
				skippedSourceCount: 1,
				deletedSourceCount: 0,
				lastErrorCode: "CONTENT_USAGE_REPAIR_CONFLICT",
			}),
		);
		expect(await usageRepo.findSource(sourceKey("post_conflict", "columns"))).toEqual(
			expect.objectContaining({
				currentGeneration: "trigger_columns_generation",
				contentTitle: "Runtime Fresh Columns",
				sourceFingerprint: "runtime-fresher-columns",
			}),
		);
		expect(await usageRepo.findCurrentUsageByMediaId("media-fresher-columns")).toHaveLength(1);
		expect(await usageRepo.findCurrentUsageByMediaId("media-repair")).toHaveLength(0);
		expect(
			await usageRepo.findIndexStatus({
				adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
				scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
				scopeKey: "posts",
			}),
		).toEqual(
			expect.objectContaining({
				status: "partial",
				indexedSourceCount: 0,
				failedSourceCount: 0,
				lastErrorCode: "CONTENT_USAGE_REPAIR_CONFLICT",
			}),
		);
	});

	it("does not delete stale observed draft sources that become fresher during repair", async () => {
		const item = await insertPost(ctx, {
			id: "post_draft_conflict",
			slug: "draft-conflict-post",
			status: "published",
			data: {
				title: "Draft Conflict Post",
				hero: { id: "media-columns", provider: "local", mimeType: "image/webp" },
			},
		});
		await usageRepo.replaceSource(contentSource(item.id, "draft_overlay"), [
			occurrence("hero", "media-stale-draft"),
		]);
		await installFresherDraftSourceDuringRepairTrigger(ctx);

		const result = await repairContentMediaUsageCollection(ctx.db, { collectionSlug: "posts" });

		expect(result).toEqual(
			expect.objectContaining({
				status: "partial",
				indexedSourceCount: 1,
				failedSourceCount: 0,
				skippedSourceCount: 1,
				deletedSourceCount: 0,
				lastErrorCode: "CONTENT_USAGE_REPAIR_CONFLICT",
			}),
		);
		expect(await usageRepo.findSource(sourceKey(item.id, "draft_overlay"))).toEqual(
			expect.objectContaining({
				currentGeneration: "trigger_draft_generation",
				contentTitle: "Runtime Fresh Draft",
				sourceFingerprint: "runtime-fresher-draft",
			}),
		);
		expect(await usageRepo.findCurrentUsageByMediaId("media-columns")).toHaveLength(1);
		expect(await usageRepo.findCurrentUsageByMediaId("media-fresher-draft")).toHaveLength(1);
		expect(await usageRepo.findCurrentUsageByMediaId("media-stale-draft")).toHaveLength(0);
	});

	it("returns the winning stale error when final status CAS loses", async () => {
		await insertPost(ctx, {
			slug: "stale-status-post",
			status: "published",
			data: {
				title: "Stale Status Post",
				hero: { id: "media-stale-status", provider: "local", mimeType: "image/webp" },
			},
		});
		await installStaleStatusTrigger(ctx);

		const result = await repairContentMediaUsageCollection(ctx.db, { collectionSlug: "posts" });

		expect(result).toEqual(
			expect.objectContaining({
				status: "stale",
				lastErrorCode: "CONTENT_USAGE_STALE",
				completedAt: null,
			}),
		);
		expect(
			await usageRepo.findIndexStatus({
				adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
				scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
				scopeKey: "posts",
			}),
		).toEqual(expect.objectContaining({ status: "stale", lastErrorCode: "CONTENT_USAGE_STALE" }));
	});

	it("deletes observed draft and orphan sources that repair proves absent", async () => {
		const item = await insertPost(ctx, {
			slug: "columns-only-post",
			status: "published",
			data: {
				title: "Columns Only",
				hero: { id: "media-live", provider: "local", mimeType: "image/webp" },
			},
		});
		await usageRepo.replaceSource(contentSource(item.id, "draft_overlay"), [
			occurrence("hero", "media-stale-draft"),
		]);
		await usageRepo.replaceSource(contentSource("missing-post", "columns"), [
			occurrence("hero", "media-orphan"),
		]);

		const result = await repairContentMediaUsageCollection(ctx.db, { collectionSlug: "posts" });

		expect(result).toEqual(
			expect.objectContaining({
				status: "complete",
				indexedSourceCount: 1,
				deletedSourceCount: 2,
			}),
		);
		expect(await usageRepo.findSource(sourceKey(item.id, "columns"))).not.toBeNull();
		expect(await usageRepo.findSource(sourceKey(item.id, "draft_overlay"))).toBeNull();
		expect(await usageRepo.findSource(sourceKey("missing-post", "columns"))).toBeNull();
		expect(await usageRepo.findCurrentUsageByMediaId("media-stale-draft")).toEqual([]);
		expect(await usageRepo.findCurrentUsageByMediaId("media-orphan")).toEqual([]);
	});

	it("returns failed without writing status for missing collections", async () => {
		const result = await repairContentMediaUsageCollection(ctx.db, { collectionSlug: "missing" });

		expect(result).toEqual(
			expect.objectContaining({
				scope: {
					adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
					scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
					scopeKey: "missing",
				},
				status: "failed",
				lastErrorCode: "COLLECTION_NOT_FOUND",
				indexedSourceCount: 0,
				failedSourceCount: 0,
				skippedSourceCount: 0,
				deletedSourceCount: 0,
			}),
		);
		expect(
			await usageRepo.findIndexStatus({
				adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
				scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
				scopeKey: "missing",
			}),
		).toBeNull();
	});
});

interface TestPostInput {
	id?: string;
	slug: string;
	status: string;
	deletedAt?: string | null;
	data: Record<string, unknown>;
}

interface TestPost {
	id: string;
}

async function insertPost(ctx: DialectTestContext, input: TestPostInput): Promise<TestPost> {
	const id = input.id ?? ulid();
	const now = new Date().toISOString();
	await sql`
		INSERT INTO ${sql.ref("ec_posts")} (
			id,
			slug,
			status,
			created_at,
			updated_at,
			deleted_at,
			version,
			locale,
			translation_group,
			title,
			hero
		) VALUES (
			${id},
			${input.slug},
			${input.status},
			${now},
			${now},
			${input.deletedAt ?? null},
			${1},
			${"en"},
			${id},
			${serializeFieldValue(input.data.title)},
			${serializeFieldValue(input.data.hero)}
		)
	`.execute(ctx.db);

	return { id };
}

function contentSource(
	contentId: string,
	variant: MediaUsageContentSourceVariant,
): Parameters<MediaUsageRepository["replaceSource"]>[0] {
	return {
		sourceKey: sourceKey(contentId, variant),
		sourceType: "content",
		collectionSlug: "posts",
		contentId,
		sourceVariant: variant,
		locale: "en",
		translationGroup: `tg-${contentId}`,
		contentSlug: contentId,
		contentTitle: contentId,
		contentStatus: "published",
		contentScheduledAt: null,
		contentDeletedAt: null,
		revisionId: null,
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

function sourceKey(contentId: string, sourceVariant: MediaUsageContentSourceVariant): string {
	return buildContentMediaUsageSourceKey({
		collectionSlug: "posts",
		contentId,
		sourceVariant,
	});
}

async function installConcurrentPostInsertTrigger(ctx: DialectTestContext): Promise<void> {
	if (ctx.dialect === "postgres") {
		await sql`
			CREATE FUNCTION media_usage_insert_concurrent_post()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				IF NEW.media_id = 'media-first' THEN
					INSERT INTO ec_posts (
						id,
						slug,
						status,
						created_at,
						updated_at,
						version,
						locale,
						translation_group,
						title,
						hero
					) VALUES (
						'post_concurrent',
						'concurrent-post',
						'published',
						'2026-01-01T00:00:00.000Z',
						'2026-01-01T00:00:00.000Z',
						1,
						'en',
						'post_concurrent',
						'Concurrent Post',
						'{"id":"media-concurrent","provider":"local","mimeType":"image/webp"}'
					)
					ON CONFLICT (id) DO NOTHING;
				END IF;
				RETURN NEW;
			END;
			$$
		`.execute(ctx.db);
		await sql`
			CREATE TRIGGER media_usage_insert_concurrent_post
			AFTER INSERT ON _emdash_media_usage
			FOR EACH ROW
			EXECUTE FUNCTION media_usage_insert_concurrent_post()
		`.execute(ctx.db);
		return;
	}

	await sql`
		CREATE TRIGGER media_usage_insert_concurrent_post
		AFTER INSERT ON _emdash_media_usage
		WHEN NEW.media_id = 'media-first'
		BEGIN
			INSERT OR IGNORE INTO ec_posts (
				id,
				slug,
				status,
				created_at,
				updated_at,
				version,
				locale,
				translation_group,
				title,
				hero
			) VALUES (
				'post_concurrent',
				'concurrent-post',
				'published',
				'2026-01-01T00:00:00.000Z',
				'2026-01-01T00:00:00.000Z',
				1,
				'en',
				'post_concurrent',
				'Concurrent Post',
				'{"id":"media-concurrent","provider":"local","mimeType":"image/webp"}'
			);
		END
	`.execute(ctx.db);
}

async function installStaleStatusTrigger(ctx: DialectTestContext): Promise<void> {
	if (ctx.dialect === "postgres") {
		await sql`
			CREATE FUNCTION media_usage_mark_status_stale()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				UPDATE _emdash_media_usage_index_status
				SET status = 'stale',
					last_error_code = 'CONTENT_USAGE_STALE',
					updated_at = '2026-01-01T00:00:01.000Z'
				WHERE adapter_id = 'content-media'
				AND scope_type = 'collection'
				AND scope_key = 'posts';
				RETURN NEW;
			END;
			$$
		`.execute(ctx.db);
		await sql`
			CREATE TRIGGER media_usage_mark_status_stale
			AFTER INSERT ON _emdash_media_usage
			FOR EACH ROW
			EXECUTE FUNCTION media_usage_mark_status_stale()
		`.execute(ctx.db);
		return;
	}

	await sql`
		CREATE TRIGGER media_usage_mark_status_stale
		AFTER INSERT ON _emdash_media_usage
		BEGIN
			UPDATE _emdash_media_usage_index_status
			SET status = 'stale',
				last_error_code = 'CONTENT_USAGE_STALE',
				updated_at = '2026-01-01T00:00:01.000Z'
			WHERE adapter_id = 'content-media'
			AND scope_type = 'collection'
			AND scope_key = 'posts';
		END
	`.execute(ctx.db);
}

async function installFresherColumnsSourceDuringRepairTrigger(
	ctx: DialectTestContext,
): Promise<void> {
	if (ctx.dialect === "postgres") {
		await sql`
			CREATE FUNCTION media_usage_insert_fresher_columns_source()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				IF NEW.media_id = 'media-repair' THEN
					INSERT INTO _emdash_media_usage_sources (
						source_key,
						source_type,
						collection_slug,
						content_id,
						source_variant,
						locale,
						translation_group,
						content_slug,
						content_title,
						content_status,
						current_generation,
						schema_version,
						source_updated_at,
						source_version,
						source_fingerprint,
						source_completeness,
						last_attempted_at,
						indexed_at,
						created_at,
						updated_at
					) VALUES (
						'content:posts:post_conflict:columns',
						'content',
						'posts',
						'post_conflict',
						'columns',
						'en',
						'post_conflict',
						'runtime-fresh-columns',
						'Runtime Fresh Columns',
						'published',
						'trigger_columns_generation',
						1,
						'2099-01-01T00:00:01.000Z',
						2,
						'runtime-fresher-columns',
						'complete',
						'2099-01-01T00:00:01.000Z',
						'2099-01-01T00:00:01.000Z',
						'2099-01-01T00:00:01.000Z',
						'2099-01-01T00:00:01.000Z'
					)
					ON CONFLICT (source_key) DO NOTHING;

					INSERT INTO _emdash_media_usage (
						id,
						source_key,
						generation,
						field_slug,
						field_path,
						occurrence_index,
						reference_type,
						media_id,
						provider,
						provider_asset_id,
						media_kind,
						mime_type,
						created_at
					) VALUES (
						'usage_trigger_columns',
						'content:posts:post_conflict:columns',
						'trigger_columns_generation',
						'hero',
						'hero',
						0,
						'image_field',
						'media-fresher-columns',
						'local',
						'media-fresher-columns',
						'image',
						'image/webp',
						'2099-01-01T00:00:01.000Z'
					)
					ON CONFLICT (id) DO NOTHING;
				END IF;
				RETURN NEW;
			END;
			$$
		`.execute(ctx.db);
		await sql`
			CREATE TRIGGER media_usage_insert_fresher_columns_source
			AFTER INSERT ON _emdash_media_usage
			FOR EACH ROW
			EXECUTE FUNCTION media_usage_insert_fresher_columns_source()
		`.execute(ctx.db);
		return;
	}

	await sql`
		CREATE TRIGGER media_usage_insert_fresher_columns_source
		AFTER INSERT ON _emdash_media_usage
		WHEN NEW.media_id = 'media-repair'
		BEGIN
			INSERT OR IGNORE INTO _emdash_media_usage_sources (
				source_key,
				source_type,
				collection_slug,
				content_id,
				source_variant,
				locale,
				translation_group,
				content_slug,
				content_title,
				content_status,
				current_generation,
				schema_version,
				source_updated_at,
				source_version,
				source_fingerprint,
				source_completeness,
				last_attempted_at,
				indexed_at,
				created_at,
				updated_at
			) VALUES (
				'content:posts:post_conflict:columns',
				'content',
				'posts',
				'post_conflict',
				'columns',
				'en',
				'post_conflict',
				'runtime-fresh-columns',
				'Runtime Fresh Columns',
				'published',
				'trigger_columns_generation',
				1,
				'2099-01-01T00:00:01.000Z',
				2,
				'runtime-fresher-columns',
				'complete',
				'2099-01-01T00:00:01.000Z',
				'2099-01-01T00:00:01.000Z',
				'2099-01-01T00:00:01.000Z',
				'2099-01-01T00:00:01.000Z'
			);

			INSERT OR IGNORE INTO _emdash_media_usage (
				id,
				source_key,
				generation,
				field_slug,
				field_path,
				occurrence_index,
				reference_type,
				media_id,
				provider,
				provider_asset_id,
				media_kind,
				mime_type,
				created_at
			) VALUES (
				'usage_trigger_columns',
				'content:posts:post_conflict:columns',
				'trigger_columns_generation',
				'hero',
				'hero',
				0,
				'image_field',
				'media-fresher-columns',
				'local',
				'media-fresher-columns',
				'image',
				'image/webp',
				'2099-01-01T00:00:01.000Z'
			);
		END
	`.execute(ctx.db);
}

async function installFresherDraftSourceDuringRepairTrigger(
	ctx: DialectTestContext,
): Promise<void> {
	if (ctx.dialect === "postgres") {
		await sql`
			CREATE FUNCTION media_usage_update_fresher_draft_source()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				IF NEW.media_id = 'media-columns' THEN
					INSERT INTO _emdash_media_usage (
						id,
						source_key,
						generation,
						field_slug,
						field_path,
						occurrence_index,
						reference_type,
						media_id,
						provider,
						provider_asset_id,
						media_kind,
						mime_type,
						created_at
					) VALUES (
						'usage_trigger_draft',
						'content:posts:post_draft_conflict:draft_overlay',
						'trigger_draft_generation',
						'hero',
						'hero',
						0,
						'image_field',
						'media-fresher-draft',
						'local',
						'media-fresher-draft',
						'image',
						'image/webp',
						'2099-01-01T00:00:01.000Z'
					)
					ON CONFLICT (id) DO NOTHING;

					UPDATE _emdash_media_usage_sources
					SET current_generation = 'trigger_draft_generation',
						source_updated_at = '2099-01-01T00:00:01.000Z',
						source_version = 2,
						source_fingerprint = 'runtime-fresher-draft',
						content_title = 'Runtime Fresh Draft',
						last_attempted_at = '2099-01-01T00:00:01.000Z',
						indexed_at = '2099-01-01T00:00:01.000Z',
						updated_at = '2099-01-01T00:00:01.000Z'
					WHERE source_key = 'content:posts:post_draft_conflict:draft_overlay';
				END IF;
				RETURN NEW;
			END;
			$$
		`.execute(ctx.db);
		await sql`
			CREATE TRIGGER media_usage_update_fresher_draft_source
			AFTER INSERT ON _emdash_media_usage
			FOR EACH ROW
			EXECUTE FUNCTION media_usage_update_fresher_draft_source()
		`.execute(ctx.db);
		return;
	}

	await sql`
		CREATE TRIGGER media_usage_update_fresher_draft_source
		AFTER INSERT ON _emdash_media_usage
		WHEN NEW.media_id = 'media-columns'
		BEGIN
			INSERT OR IGNORE INTO _emdash_media_usage (
				id,
				source_key,
				generation,
				field_slug,
				field_path,
				occurrence_index,
				reference_type,
				media_id,
				provider,
				provider_asset_id,
				media_kind,
				mime_type,
				created_at
			) VALUES (
				'usage_trigger_draft',
				'content:posts:post_draft_conflict:draft_overlay',
				'trigger_draft_generation',
				'hero',
				'hero',
				0,
				'image_field',
				'media-fresher-draft',
				'local',
				'media-fresher-draft',
				'image',
				'image/webp',
				'2099-01-01T00:00:01.000Z'
			);

			UPDATE _emdash_media_usage_sources
			SET current_generation = 'trigger_draft_generation',
				source_updated_at = '2099-01-01T00:00:01.000Z',
				source_version = 2,
				source_fingerprint = 'runtime-fresher-draft',
				content_title = 'Runtime Fresh Draft',
				last_attempted_at = '2099-01-01T00:00:01.000Z',
				indexed_at = '2099-01-01T00:00:01.000Z',
				updated_at = '2099-01-01T00:00:01.000Z'
			WHERE source_key = 'content:posts:post_draft_conflict:draft_overlay';
		END
	`.execute(ctx.db);
}

function serializeFieldValue(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === "object") return JSON.stringify(value);
	return value;
}
