import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import { encodeCursor, InvalidCursorError } from "../../../src/database/repositories/types.js";
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

describeEachDialect("MediaUsageRepository reads", (dialect) => {
	let ctx: DialectTestContext;
	let repo: MediaUsageRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		repo = new MediaUsageRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("counts distinct active entries across occurrences, locales, and collections", async () => {
		await registerCollection(ctx, "pages");
		await registerCollection(ctx, "posts");

		await repo.replaceSource(contentSource("entry-en", "columns"), [
			occurrence("hero", "media-shared"),
			occurrence("body", "media-shared"),
		]);
		await repo.replaceSource(
			contentSource("entry-fr", "columns", {
				locale: "fr",
				translationGroup: "translations-1",
			}),
			[occurrence("hero", "media-shared")],
		);
		await repo.replaceSource(contentSource("entry-en", "columns", { collectionSlug: "pages" }), [
			occurrence("hero", "media-shared"),
		]);

		const counts = await repo.findActiveEntryCountsByMediaIds(["media-shared", "media-none"]);

		expect(counts).toEqual(
			new Map([
				["media-shared", 3],
				["media-none", 0],
			]),
		);
	});

	it("selects published sources and the non-published visible working copy", async () => {
		await registerCollection(ctx, "posts");

		await repo.replaceSource(
			contentSource("published", "columns", { contentStatus: "published" }),
			[occurrence("hero", "media-published")],
		);
		await repo.replaceSource(
			contentSource("published", "draft_overlay", { contentStatus: "published" }),
			[occurrence("hero", "media-pending")],
		);

		await repo.replaceSource(contentSource("draft", "columns", { contentStatus: "draft" }), [
			occurrence("hero", "media-superseded"),
		]);
		await repo.replaceSource(contentSource("draft", "draft_overlay", { contentStatus: "draft" }), [
			occurrence("hero", "media-visible"),
		]);

		await repo.replaceSource(contentSource("cleared", "columns", { contentStatus: "draft" }), [
			occurrence("hero", "media-cleared"),
		]);
		await repo.replaceSource(
			contentSource("cleared", "draft_overlay", { contentStatus: "draft" }),
			[],
		);

		await repo.replaceSource(contentSource("failed", "columns", { contentStatus: "draft" }), [
			occurrence("hero", "media-failed-overlay"),
		]);
		await repo.markSourceAttempted(
			contentSource("failed", "draft_overlay", {
				contentStatus: "draft",
				sourceCompleteness: "failed",
				lastErrorCode: "DRAFT_REVISION_INVALID",
			}),
		);

		await repo.replaceSource(contentSource("no-overlay", "columns", { contentStatus: "draft" }), [
			occurrence("hero", "media-columns"),
		]);

		const counts = await repo.findActiveEntryCountsByMediaIds([
			"media-published",
			"media-pending",
			"media-superseded",
			"media-visible",
			"media-cleared",
			"media-failed-overlay",
			"media-columns",
		]);

		expect(Object.fromEntries(counts)).toEqual({
			"media-published": 1,
			"media-pending": 1,
			"media-superseded": 0,
			"media-visible": 1,
			"media-cleared": 0,
			"media-failed-overlay": 0,
			"media-columns": 1,
		});
	});

	it("excludes trash, deleted collections, and stale generations from active counts", async () => {
		await registerCollection(ctx, "posts");

		await repo.replaceSource(
			contentSource("trash", "columns", { contentDeletedAt: "2026-01-01T00:00:00.000Z" }),
			[occurrence("hero", "media-trash")],
		);
		await repo.replaceSource(
			contentSource("inconsistent-trash", "columns", { contentStatus: "published" }),
			[occurrence("hero", "media-inconsistent-trash")],
		);
		await repo.replaceSource(
			contentSource("inconsistent-trash", "draft_overlay", {
				contentStatus: "published",
				contentDeletedAt: "2026-01-02T00:00:00.000Z",
			}),
			[occurrence("body", "media-inconsistent-trash")],
		);
		await repo.replaceSource(
			contentSource("ghost", "columns", { collectionSlug: "deleted_collection" }),
			[occurrence("hero", "media-ghost")],
		);
		await repo.replaceSource(contentSource("generation", "columns"), [
			occurrence("hero", "media-stale-generation"),
		]);
		await repo.replaceSource(contentSource("generation", "columns"), [
			occurrence("hero", "media-current-generation"),
		]);
		await repo.replaceSource(
			contentSource("restored", "columns", {
				contentDeletedAt: "2026-01-03T00:00:00.000Z",
			}),
			[occurrence("hero", "media-restored")],
		);
		await repo.replaceSource(contentSource("restored", "columns"), [
			occurrence("hero", "media-restored"),
		]);
		await repo.replaceSource(contentSource("provider-only", "columns"), [
			occurrence("hero", "unused-local-id", {
				mediaId: null,
				provider: "external",
				providerAssetId: "media-provider-only",
			}),
		]);

		const counts = await repo.findActiveEntryCountsByMediaIds([
			"media-trash",
			"media-inconsistent-trash",
			"media-ghost",
			"media-stale-generation",
			"media-current-generation",
			"media-restored",
			"media-provider-only",
		]);

		expect(Object.fromEntries(counts)).toEqual({
			"media-trash": 0,
			"media-inconsistent-trash": 0,
			"media-ghost": 0,
			"media-stale-generation": 0,
			"media-current-generation": 1,
			"media-restored": 1,
			"media-provider-only": 0,
		});
	});

	it("quarantines legacy and replaced-collection sources after activation", async () => {
		await ctx.db
			.insertInto("_emdash_collections")
			.values({ id: "collection-posts-old", slug: "posts", label: "Old posts" })
			.execute();
		await installCanonicalContentFixture(ctx, "posts", "old-only", "rev-old-only-columns");
		await repo.replaceSource(
			contentSource("old-only", "columns", {
				sourceKey: buildContentMediaUsageSourceKey({
					collectionId: "collection-posts-old",
					collectionSlug: "posts",
					contentId: "old-only",
					sourceVariant: "columns",
				}),
				collectionId: "collection-posts-old",
				identityVersion: 1,
				sourceVersion: 1,
				sourceUpdatedAt: "2026-08-12T00:00:00.000Z",
			}),
			[occurrence("hero", "media-shared")],
		);
		await ctx.db
			.deleteFrom("_emdash_collections")
			.where("id", "=", "collection-posts-old")
			.execute();
		await ctx.db
			.insertInto("_emdash_collections")
			.values({ id: "collection-posts", slug: "posts", label: "Posts" })
			.execute();
		await repo.replaceSource(contentSource("legacy-only", "columns"), [
			occurrence("hero", "media-shared"),
		]);
		const legacyDeletedAt = "2026-01-01T00:00:00.000Z";
		await repo.replaceSource(
			contentSource("current", "columns", {
				contentDeletedAt: legacyDeletedAt,
			}),
			[occurrence("legacy", "media-shared")],
		);
		await repo.replaceSource(
			contentSource("current", "draft_overlay", {
				contentDeletedAt: legacyDeletedAt,
			}),
			[],
		);
		await repo.replaceSource(
			contentSource("unversioned", "columns", {
				sourceKey: buildContentMediaUsageSourceKey({
					collectionId: "collection-posts",
					collectionSlug: "posts",
					contentId: "unversioned",
					sourceVariant: "columns",
				}),
				collectionId: "collection-posts",
			}),
			[occurrence("unversioned", "media-shared")],
		);
		await installCanonicalContentFixture(ctx, "posts", "current", "rev-current-columns");
		await repo.replaceSource(
			contentSource("current", "columns", {
				sourceKey: buildContentMediaUsageSourceKey({
					collectionId: "collection-posts",
					collectionSlug: "posts",
					contentId: "current",
					sourceVariant: "columns",
				}),
				collectionId: "collection-posts",
				contentStatus: "draft",
				identityVersion: 1,
				sourceVersion: 1,
				sourceUpdatedAt: "2026-08-12T00:00:00.000Z",
			}),
			[occurrence("canonical", "media-shared")],
		);

		const legacyCounts = await repo.findActiveEntryCountsByMediaIds(["media-shared"]);
		const legacyPage = await repo.findCurrentEntryUsagePageByMediaId("media-shared");

		expect(legacyCounts.get("media-shared")).toBe(3);
		expect(legacyPage.items.map(entryIdentity)).toEqual([
			["posts", "current"],
			["posts", "legacy-only"],
			["posts", "old-only"],
			["posts", "unversioned"],
		]);
		expect(legacyPage.items[0]?.contentDeletedAt).toBe(legacyDeletedAt);
		expect(
			legacyPage.items[0]?.sources.flatMap((source) =>
				source.occurrences.map((item) => item.fieldSlug),
			),
		).toEqual(["legacy"]);

		await ctx.db
			.updateTable("_emdash_media_usage_activation")
			.set({ state: "active" })
			.where("task_key", "=", "incremental_capture")
			.execute();

		const counts = await repo.findActiveEntryCountsByMediaIds(["media-shared"]);
		const page = await repo.findCurrentEntryUsagePageByMediaId("media-shared");

		expect(counts.get("media-shared")).toBe(1);
		expect(page.items.map(entryIdentity)).toEqual([["posts", "current"]]);
		expect(page.items[0]?.contentDeletedAt).toBeNull();
		expect(
			page.items[0]?.sources.flatMap((source) => source.occurrences.map((item) => item.fieldSlug)),
		).toEqual(["canonical"]);
	});

	it("returns trashed entries in details while excluding them from active counts", async () => {
		await registerCollection(ctx, "posts");
		const deletedAt = "2026-01-01T00:00:00.000Z";
		await repo.replaceSource(contentSource("trash", "columns", { contentDeletedAt: deletedAt }), [
			occurrence("hero", "media-trash"),
		]);

		const counts = await repo.findActiveEntryCountsByMediaIds(["media-trash"]);
		const page = await repo.findCurrentEntryUsagePageByMediaId("media-trash");

		expect(counts.get("media-trash")).toBe(0);
		expect(page.items.map(entryIdentity)).toEqual([["posts", "trash"]]);
		expect(page.items[0]?.contentDeletedAt).toBe(deletedAt);
	});

	it("returns zero-filled counts across multiple D1-sized batches", async () => {
		const mediaIds = Array.from({ length: SQL_BATCH_SIZE + 1 }, (_, index) => `media-${index}`);

		const counts = await repo.findActiveEntryCountsByMediaIds(mediaIds);

		expect(counts.size).toBe(mediaIds.length);
		expect([...counts.values()].every((count) => count === 0)).toBe(true);
	});

	it("loads status coverage for every current collection and ignores orphan statuses", async () => {
		await registerCollection(ctx, "pages");
		await registerCollection(ctx, "posts");
		await repo.upsertIndexStatus({
			adapterId: "content-media",
			scopeType: "collection",
			scopeKey: "posts",
			status: "complete",
			schemaVersion: 2,
		});
		await repo.upsertIndexStatus({
			adapterId: "content-media",
			scopeType: "collection",
			scopeKey: "deleted_collection",
			status: "failed",
		});

		const scopes = await repo.findCollectionIndexStatusScopes({
			adapterId: "content-media",
			scopeType: "collection",
		});

		expect(scopes).toEqual([
			{
				collectionSlug: "pages",
				status: null,
				schemaVersion: null,
				reconciliationRequired: false,
			},
			{
				collectionSlug: "posts",
				status: "complete",
				schemaVersion: 2,
				reconciliationRequired: false,
			},
		]);
	});

	it("paginates complete entry groups with nested sources and occurrences", async () => {
		await registerCollection(ctx, "pages");
		await registerCollection(ctx, "posts");

		await repo.replaceSource(
			contentSource("entry-a", "columns", {
				contentStatus: "published",
				contentTitle: "Published title",
			}),
			[occurrence("hero", "media-shared"), occurrence("body", "media-shared")],
		);
		await repo.replaceSource(
			contentSource("entry-a", "draft_overlay", {
				contentStatus: "published",
				contentTitle: "Draft title",
				contentDeletedAt: "2026-01-02T00:00:00.000Z",
			}),
			[occurrence("draftHero", "media-shared")],
		);
		await repo.replaceSource(contentSource("entry-b", "columns", { contentStatus: "draft" }), [
			occurrence("hero", "media-shared"),
		]);
		await repo.replaceSource(
			contentSource("entry-b", "draft_overlay", { contentStatus: "draft" }),
			[occurrence("hero", "media-other")],
		);
		await repo.replaceSource(contentSource("entry-c", "columns"), [
			occurrence("hero", "media-shared"),
		]);
		await repo.replaceSource(contentSource("entry-d", "columns", { collectionSlug: "pages" }), [
			occurrence("hero", "media-shared"),
		]);

		const first = await repo.findCurrentEntryUsagePageByMediaId("media-shared", { limit: 2 });

		expect(first.items.map(entryIdentity)).toEqual([
			["pages", "entry-d"],
			["posts", "entry-a"],
		]);
		expect(first.nextCursor).toEqual(expect.any(String));

		const entryA = first.items[1]!;
		expect(entryA.contentDeletedAt).toBe("2026-01-02T00:00:00.000Z");
		expect(entryA.sources.map((source) => source.source.sourceVariant)).toEqual([
			"columns",
			"draft_overlay",
		]);
		expect(
			entryA.sources.flatMap((source) => source.occurrences.map((item) => item.fieldPath)),
		).toEqual(["body", "hero", "draftHero"]);

		const second = await repo.findCurrentEntryUsagePageByMediaId("media-shared", {
			limit: 2,
			cursor: first.nextCursor,
		});
		expect(second.items.map(entryIdentity)).toEqual([["posts", "entry-c"]]);
		expect(second.nextCursor).toBeUndefined();
	});

	it("rejects malformed entry-group cursors", async () => {
		await expect(
			repo.findCurrentEntryUsagePageByMediaId("media-shared", { cursor: "not-a-cursor" }),
		).rejects.toBeInstanceOf(InvalidCursorError);
	});

	it.each([encodeCursor("", "entry-a"), encodeCursor("posts", "")])(
		"rejects structurally empty entry-group cursor components",
		async (cursor) => {
			await expect(
				repo.findCurrentEntryUsagePageByMediaId("media-shared", { cursor }),
			).rejects.toBeInstanceOf(InvalidCursorError);
		},
	);

	it("defaults non-finite entry-group limits", async () => {
		await registerCollection(ctx, "posts");
		await repo.replaceSource(contentSource("entry-a", "columns"), [
			occurrence("hero", "media-shared"),
		]);

		const page = await repo.findCurrentEntryUsagePageByMediaId("media-shared", {
			limit: Number.NaN,
		});

		expect(page.items.map(entryIdentity)).toEqual([["posts", "entry-a"]]);
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
		contentSlug: `slug-${contentId}`,
		contentTitle: `Title ${contentId}`,
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

async function registerCollection(ctx: DialectTestContext, slug: string): Promise<void> {
	await ctx.db
		.insertInto("_emdash_collections")
		.values({ id: `collection-${slug}`, slug, label: slug, has_seo: 0 })
		.execute();
}

async function installCanonicalContentFixture(
	ctx: DialectTestContext,
	collectionSlug: string,
	contentId: string,
	liveRevisionId: string,
): Promise<void> {
	const tableName = `ec_${collectionSlug}`;
	await sql`
		CREATE TABLE IF NOT EXISTS ${sql.ref(tableName)} (
			id TEXT PRIMARY KEY,
			version INTEGER NOT NULL,
			updated_at TEXT NOT NULL,
			live_revision_id TEXT,
			draft_revision_id TEXT
		)
	`.execute(ctx.db);
	await sql`
		INSERT INTO ${sql.ref(tableName)} (
			id, version, updated_at, live_revision_id, draft_revision_id
		) VALUES (
			${contentId}, 1, '2026-08-12T00:00:00.000Z', ${liveRevisionId}, NULL
		)
	`.execute(ctx.db);
}

function entryIdentity(entry: { collectionSlug: string; contentId: string }): [string, string] {
	return [entry.collectionSlug, entry.contentId];
}
