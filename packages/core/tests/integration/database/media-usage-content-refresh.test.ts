import { sql } from "kysely";
import { ulid } from "ulidx";
import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import {
	CONTENT_MEDIA_USAGE_ADAPTER_ID,
	CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
	deleteContentMediaUsage,
	markContentMediaUsageCollectionStale,
	refreshContentMediaUsage,
} from "../../../src/media/usage/content-refresh.js";
import { buildContentMediaUsageSourceKey } from "../../../src/media/usage/source-key.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("content media usage refresh", (dialect) => {
	let ctx: DialectTestContext;
	let registry: SchemaRegistry;
	let usageRepo: MediaUsageRepository;
	let revisionRepo: RevisionRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		registry = new SchemaRegistry(ctx.db);
		usageRepo = new MediaUsageRepository(ctx.db);
		revisionRepo = new RevisionRepository(ctx.db);

		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "hero", label: "Hero", type: "image" });
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("refreshes a columns source and replaces its current usage", async () => {
		const item = await insertPost(ctx, {
			slug: "hello-world",
			status: "published",
			data: {
				title: "Hello World",
				hero: { id: "media-old", provider: "local", mimeType: "image/webp" },
			},
		});
		const columnsKey = sourceKey(item.id, "columns");

		const first = await refreshContentMediaUsage(ctx.db, "posts", item.id);

		expect(first).toEqual({
			success: true,
			refreshedSourceCount: 1,
			deletedSourceCount: 0,
			failedSourceCount: 0,
		});
		const firstSource = await usageRepo.findSource(columnsKey);
		expect(firstSource).toEqual(
			expect.objectContaining({
				sourceKey: columnsKey,
				sourceCompleteness: "complete",
				contentTitle: "Hello World",
				sourceFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
			}),
		);
		expect(await usageRepo.findCurrentUsageByMediaId("media-old")).toEqual([
			expect.objectContaining({
				source: expect.objectContaining({ sourceKey: columnsKey }),
				occurrence: expect.objectContaining({ fieldPath: "hero", mediaId: "media-old" }),
			}),
		]);
		expect(
			await usageRepo.findIndexStatus({
				adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
				scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
				scopeKey: "posts",
			}),
		).toEqual(
			expect.objectContaining({
				status: "stale",
				lastErrorCode: "CONTENT_USAGE_STALE",
			}),
		);

		await updatePostHero(ctx, item.id, {
			id: "media-new",
			provider: "local",
			mimeType: "image/webp",
		});
		const second = await refreshContentMediaUsage(ctx.db, "posts", item.id);

		expect(second).toEqual({
			success: true,
			refreshedSourceCount: 1,
			deletedSourceCount: 0,
			failedSourceCount: 0,
		});
		expect((await usageRepo.findSource(columnsKey))?.currentGeneration).not.toBe(
			firstSource?.currentGeneration,
		);
		expect(await usageRepo.findCurrentUsageByMediaId("media-old")).toEqual([]);
		expect(await usageRepo.findCurrentUsageByMediaId("media-new")).toEqual([
			expect.objectContaining({
				source: expect.objectContaining({ sourceKey: columnsKey }),
				occurrence: expect.objectContaining({ fieldPath: "hero", mediaId: "media-new" }),
			}),
		]);
	});

	it("refreshes columns and draft overlay sources when a draft exists", async () => {
		const item = await insertPost(ctx, {
			slug: "live-post",
			status: "published",
			data: {
				title: "Live Title",
				hero: { id: "media-live", provider: "local", mimeType: "image/webp" },
			},
		});
		const draft = await revisionRepo.create({
			collection: "posts",
			entryId: item.id,
			data: {
				title: "Draft Title",
				hero: { id: "media-draft", provider: "local", mimeType: "image/webp" },
			},
		});
		await setDraftRevision(ctx, item.id, draft.id);

		const result = await refreshContentMediaUsage(ctx.db, "posts", item.id);

		expect(result).toEqual({
			success: true,
			refreshedSourceCount: 2,
			deletedSourceCount: 0,
			failedSourceCount: 0,
		});
		expect(await usageRepo.findSource(sourceKey(item.id, "columns"))).toEqual(
			expect.objectContaining({ sourceVariant: "columns", contentTitle: "Live Title" }),
		);
		expect(await usageRepo.findSource(sourceKey(item.id, "draft_overlay"))).toEqual(
			expect.objectContaining({
				sourceVariant: "draft_overlay",
				contentTitle: "Draft Title",
				revisionId: draft.id,
			}),
		);
		expect(await usageRepo.findCurrentUsageByMediaId("media-live")).toEqual([
			expect.objectContaining({ source: expect.objectContaining({ sourceVariant: "columns" }) }),
		]);
		expect(await usageRepo.findCurrentUsageByMediaId("media-draft")).toEqual([
			expect.objectContaining({
				source: expect.objectContaining({ sourceVariant: "draft_overlay" }),
			}),
		]);
	});

	it("deletes a stale draft overlay source after a successful columns-only refresh", async () => {
		const item = await insertPost(ctx, {
			slug: "live-post",
			status: "published",
			data: {
				title: "Live Title",
				hero: { id: "media-live", provider: "local", mimeType: "image/webp" },
			},
		});
		const draft = await revisionRepo.create({
			collection: "posts",
			entryId: item.id,
			data: { hero: { id: "media-draft", provider: "local", mimeType: "image/webp" } },
		});
		await setDraftRevision(ctx, item.id, draft.id);
		await refreshContentMediaUsage(ctx.db, "posts", item.id);
		expect(await usageRepo.findSource(sourceKey(item.id, "draft_overlay"))).not.toBeNull();

		await clearDraftRevision(ctx, item.id);
		const result = await refreshContentMediaUsage(ctx.db, "posts", item.id);

		expect(result).toEqual({
			success: true,
			refreshedSourceCount: 1,
			deletedSourceCount: 1,
			failedSourceCount: 0,
		});
		expect(await usageRepo.findSource(sourceKey(item.id, "columns"))).not.toBeNull();
		expect(await usageRepo.findSource(sourceKey(item.id, "draft_overlay"))).toBeNull();
		expect(await usageRepo.findCurrentUsageByMediaId("media-draft")).toEqual([]);
	});

	it("deletes every source for a content item", async () => {
		const item = await insertPost(ctx, {
			slug: "live-post",
			status: "published",
			data: {
				title: "Live Title",
				hero: { id: "media-live", provider: "local", mimeType: "image/webp" },
			},
		});
		const draft = await revisionRepo.create({
			collection: "posts",
			entryId: item.id,
			data: { hero: { id: "media-draft", provider: "local", mimeType: "image/webp" } },
		});
		await setDraftRevision(ctx, item.id, draft.id);
		await refreshContentMediaUsage(ctx.db, "posts", item.id);

		const result = await deleteContentMediaUsage(ctx.db, "posts", item.id);

		expect(result).toEqual({
			success: true,
			refreshedSourceCount: 0,
			deletedSourceCount: 2,
			failedSourceCount: 0,
		});
		expect(await usageRepo.findSource(sourceKey(item.id, "columns"))).toBeNull();
		expect(await usageRepo.findSource(sourceKey(item.id, "draft_overlay"))).toBeNull();
		expect(await usageRepo.findCurrentUsageByMediaId("media-live")).toEqual([]);
		expect(await usageRepo.findCurrentUsageByMediaId("media-draft")).toEqual([]);
	});

	it("marks draft snapshot failures without replacing current usage", async () => {
		const item = await insertPost(ctx, {
			slug: "live-post",
			status: "published",
			data: {
				title: "Live Title",
				hero: { id: "media-live", provider: "local", mimeType: "image/webp" },
			},
		});
		await refreshContentMediaUsage(ctx.db, "posts", item.id);
		const revisionId = ulid();
		await sql`
			INSERT INTO revisions (id, collection, entry_id, data, author_id)
			VALUES (${revisionId}, ${"posts"}, ${item.id}, ${"{"}, ${null})
		`.execute(ctx.db);
		await setDraftRevision(ctx, item.id, revisionId);

		const result = await refreshContentMediaUsage(ctx.db, "posts", item.id);

		expect(result).toEqual({
			success: false,
			refreshedSourceCount: 0,
			deletedSourceCount: 0,
			failedSourceCount: 1,
			errorCode: "DRAFT_REVISION_INVALID",
		});
		expect(await usageRepo.findSource(sourceKey(item.id, "columns"))).toEqual(
			expect.objectContaining({ sourceCompleteness: "complete" }),
		);
		expect(await usageRepo.findSource(sourceKey(item.id, "draft_overlay"))).toEqual(
			expect.objectContaining({
				sourceCompleteness: "failed",
				lastErrorCode: "DRAFT_REVISION_INVALID",
			}),
		);
		expect(await usageRepo.findCurrentUsageByMediaId("media-live")).toEqual([
			expect.objectContaining({ source: expect.objectContaining({ sourceVariant: "columns" }) }),
		]);
		expect(
			await usageRepo.findIndexStatus({
				adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
				scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
				scopeKey: "posts",
			}),
		).toEqual(
			expect.objectContaining({
				status: "stale",
				lastErrorCode: "DRAFT_REVISION_INVALID",
			}),
		);
	});

	it("marks collection coverage stale while preserving existing status metadata", async () => {
		await usageRepo.upsertIndexStatus({
			adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
			scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
			scopeKey: "posts",
			status: "partial",
			schemaVersion: 7,
			startedAt: "2026-01-01T00:00:00.000Z",
			completedAt: "2026-01-01T00:00:02.000Z",
			cursor: "cursor-1",
			indexedSourceCount: 12,
			failedSourceCount: 3,
			lastErrorCode: "OLD_ERROR",
			updatedAt: "2026-01-01T00:00:03.000Z",
		});

		await markContentMediaUsageCollectionStale(ctx.db, "posts", "SCHEMA_FIELD_CHANGED");

		expect(
			await usageRepo.findIndexStatus({
				adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
				scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
				scopeKey: "posts",
			}),
		).toEqual(
			expect.objectContaining({
				status: "stale",
				schemaVersion: 7,
				startedAt: "2026-01-01T00:00:00.000Z",
				completedAt: "2026-01-01T00:00:02.000Z",
				cursor: "cursor-1",
				indexedSourceCount: 12,
				failedSourceCount: 3,
				lastErrorCode: "SCHEMA_FIELD_CHANGED",
			}),
		);
	});
});

interface TestPostInput {
	slug: string;
	status: string;
	locale?: string;
	data: Record<string, unknown>;
}

interface TestPost {
	id: string;
	slug: string;
	status: string;
	translationGroup: string;
}

async function insertPost(ctx: DialectTestContext, input: TestPostInput): Promise<TestPost> {
	const id = ulid();
	const now = new Date().toISOString();
	await sql`
		INSERT INTO ${sql.ref("ec_posts")} (
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
			${id},
			${input.slug},
			${input.status},
			${now},
			${now},
			${1},
			${input.locale ?? "en"},
			${id},
			${serializeFieldValue(input.data.title)},
			${serializeFieldValue(input.data.hero)}
		)
	`.execute(ctx.db);

	return {
		id,
		slug: input.slug,
		status: input.status,
		translationGroup: id,
	};
}

async function updatePostHero(
	ctx: DialectTestContext,
	contentId: string,
	hero: Record<string, unknown>,
): Promise<void> {
	await sql`
		UPDATE ${sql.ref("ec_posts")}
		SET hero = ${serializeFieldValue(hero)},
			updated_at = ${new Date().toISOString()}
		WHERE id = ${contentId}
	`.execute(ctx.db);
}

async function setDraftRevision(
	ctx: DialectTestContext,
	contentId: string,
	revisionId: string,
): Promise<void> {
	await sql`
		UPDATE ${sql.ref("ec_posts")}
		SET draft_revision_id = ${revisionId},
			updated_at = ${new Date().toISOString()}
		WHERE id = ${contentId}
	`.execute(ctx.db);
}

async function clearDraftRevision(ctx: DialectTestContext, contentId: string): Promise<void> {
	await sql`
		UPDATE ${sql.ref("ec_posts")}
		SET draft_revision_id = ${null},
			updated_at = ${new Date().toISOString()}
		WHERE id = ${contentId}
	`.execute(ctx.db);
}

function sourceKey(contentId: string, sourceVariant: "columns" | "draft_overlay"): string {
	return buildContentMediaUsageSourceKey({
		collectionSlug: "posts",
		contentId,
		sourceVariant,
	});
}

function serializeFieldValue(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === "object") return JSON.stringify(value);
	return value;
}
