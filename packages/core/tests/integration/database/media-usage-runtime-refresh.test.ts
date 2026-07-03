import { sql } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import {
	CONTENT_MEDIA_USAGE_ADAPTER_ID,
	CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
} from "../../../src/media/usage/content-refresh.js";
import { buildContentMediaUsageSourceKey } from "../../../src/media/usage/source-key.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("runtime content media usage refresh", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;
	let usageRepo: MediaUsageRepository;
	let revisionRepo: RevisionRepository;

	beforeEach(async () => {
		setI18nConfig(null);
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "hero", label: "Hero", type: "image" });
		await registry.createField("posts", {
			slug: "shared_hero",
			label: "Shared Hero",
			type: "image",
			translatable: false,
		});
		await registry.createCollection({ slug: "plain_posts", label: "Plain Posts", supports: [] });
		await registry.createField("plain_posts", {
			slug: "title",
			label: "Title",
			type: "string",
		});
		await registry.createField("plain_posts", { slug: "hero", label: "Hero", type: "image" });
		await registry.createCollection({
			slug: "localized_posts",
			label: "Localized Posts",
			supports: [],
		});
		await registry.createField("localized_posts", {
			slug: "title",
			label: "Title",
			type: "string",
			translatable: false,
		});
		await registry.createField("localized_posts", {
			slug: "hero",
			label: "Hero",
			type: "image",
		});
		await registry.createField("localized_posts", {
			slug: "shared_hero",
			label: "Shared Hero",
			type: "image",
			translatable: false,
		});
		await registry.createField("localized_posts", {
			slug: "summary",
			label: "Summary",
			type: "string",
			translatable: false,
		});

		runtime = createTestRuntime(ctx.db);
		usageRepo = new MediaUsageRepository(ctx.db);
		revisionRepo = new RevisionRepository(ctx.db);
	});

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(ctx);
	});

	it("refreshes columns usage after runtime content create", async () => {
		const created = await runtime.handleContentCreate("plain_posts", {
			slug: "created-post",
			data: {
				title: "Created Post",
				hero: mediaRef("media-created"),
			},
		});

		expect(created.success).toBe(true);
		if (!created.success) throw new Error(created.error.message);
		const contentId = created.data.item.id;
		expect(await usageRepo.findSource(sourceKey("plain_posts", contentId, "columns"))).toEqual(
			expect.objectContaining({
				contentTitle: "Created Post",
				sourceCompleteness: "complete",
			}),
		);
		expect(await usageRepo.findCurrentUsageByMediaId("media-created")).toEqual([
			expect.objectContaining({
				source: expect.objectContaining({ contentId, sourceVariant: "columns" }),
				occurrence: expect.objectContaining({ fieldPath: "hero", mediaId: "media-created" }),
			}),
		]);
	});

	it("refreshes columns usage after runtime non-revision content update", async () => {
		const created = await runtime.handleContentCreate("plain_posts", {
			slug: "updated-post",
			data: {
				title: "Updated Post",
				hero: mediaRef("media-old"),
			},
		});
		expect(created.success).toBe(true);
		if (!created.success) throw new Error(created.error.message);

		const updated = await runtime.handleContentUpdate("plain_posts", created.data.item.id, {
			data: { hero: mediaRef("media-new") },
		});

		expect(updated.success).toBe(true);
		expect(await usageRepo.findCurrentUsageByMediaId("media-old")).toEqual([]);
		expect(await usageRepo.findCurrentUsageByMediaId("media-new")).toEqual([
			expect.objectContaining({
				source: expect.objectContaining({
					contentId: created.data.item.id,
					sourceVariant: "columns",
				}),
			}),
		]);
	});

	it("refreshes draft overlay usage after runtime revision-enabled content update", async () => {
		const created = await runtime.handleContentCreate("posts", {
			slug: "drafted-post",
			data: {
				title: "Drafted Post",
				hero: mediaRef("media-live"),
			},
		});
		expect(created.success).toBe(true);
		if (!created.success) throw new Error(created.error.message);

		const updated = await runtime.handleContentUpdate("posts", created.data.item.id, {
			data: { hero: mediaRef("media-draft") },
		});

		expect(updated.success).toBe(true);
		expect(await usageRepo.findSource(sourceKey("posts", created.data.item.id, "columns"))).toEqual(
			expect.objectContaining({ sourceVariant: "columns", contentTitle: "Drafted Post" }),
		);
		expect(
			await usageRepo.findSource(sourceKey("posts", created.data.item.id, "draft_overlay")),
		).toEqual(expect.objectContaining({ sourceVariant: "draft_overlay" }));
		expect(await usageRepo.findCurrentUsageByMediaId("media-live")).toEqual([
			expect.objectContaining({ source: expect.objectContaining({ sourceVariant: "columns" }) }),
		]);
		expect(await usageRepo.findCurrentUsageByMediaId("media-draft")).toEqual([
			expect.objectContaining({
				source: expect.objectContaining({ sourceVariant: "draft_overlay" }),
			}),
		]);
	});

	it("keeps runtime updates successful when draft overlay usage refresh fails", async () => {
		const created = await runtime.handleContentCreate("posts", {
			slug: "failed-refresh-post",
			data: {
				title: "Failed Refresh Post",
				hero: mediaRef("media-live-before-failure"),
			},
		});
		expect(created.success).toBe(true);
		if (!created.success) throw new Error(created.error.message);
		const contentId = created.data.item.id;

		const firstDraft = await runtime.handleContentUpdate("posts", contentId, {
			data: { hero: mediaRef("media-draft-before-failure") },
		});
		expect(firstDraft.success).toBe(true);
		const draftSourceBefore = await usageRepo.findSource(
			sourceKey("posts", contentId, "draft_overlay"),
		);
		expect(draftSourceBefore).toEqual(
			expect.objectContaining({
				sourceCompleteness: "complete",
				lastErrorCode: null,
			}),
		);
		expect(await usageRepo.findCurrentUsageByMediaId("media-draft-before-failure")).toEqual([
			expect.objectContaining({
				source: expect.objectContaining({ contentId, sourceVariant: "draft_overlay" }),
			}),
		]);
		await corruptFuturePostDraftRevisionSnapshots(ctx);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		const updated = await runtime
			.handleContentUpdate("posts", contentId, {
				data: { hero: mediaRef("media-draft-after-failure") },
			})
			.finally(() => {
				consoleError.mockRestore();
			});

		expect(updated.success).toBe(true);
		const draftSourceAfter = await usageRepo.findSource(
			sourceKey("posts", contentId, "draft_overlay"),
		);
		expect(draftSourceAfter).toEqual(
			expect.objectContaining({
				sourceCompleteness: "failed",
				lastErrorCode: "DRAFT_REVISION_INVALID",
			}),
		);
		expect(draftSourceAfter?.currentGeneration).toBe(draftSourceBefore?.currentGeneration);
		expect(await usageRepo.findCurrentUsageByMediaId("media-draft-before-failure")).toEqual([
			expect.objectContaining({
				source: expect.objectContaining({
					contentId,
					sourceVariant: "draft_overlay",
					lastErrorCode: "DRAFT_REVISION_INVALID",
				}),
			}),
		]);
		expect(await usageRepo.findCurrentUsageByMediaId("media-draft-after-failure")).toEqual([]);
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

	it("refreshes columns usage for duplicated content", async () => {
		const created = await runtime.handleContentCreate("plain_posts", {
			slug: "original-post",
			data: {
				title: "Original Post",
				hero: mediaRef("media-copy"),
			},
		});
		expect(created.success).toBe(true);
		if (!created.success) throw new Error(created.error.message);

		const duplicated = await runtime.handleContentDuplicate("plain_posts", created.data.item.id);

		expect(duplicated.success).toBe(true);
		if (!duplicated.success) throw new Error(duplicated.error.message);
		expect(await usageRepo.findCurrentUsageByMediaId("media-copy")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: expect.objectContaining({
						contentId: duplicated.data.item.id,
						sourceVariant: "columns",
					}),
				}),
			]),
		);
	});

	it("refreshes draft overlay usage after runtime revision restore", async () => {
		const created = await runtime.handleContentCreate("posts", {
			slug: "restored-post",
			data: {
				title: "Restored Post",
				hero: mediaRef("media-live"),
			},
		});
		expect(created.success).toBe(true);
		if (!created.success) throw new Error(created.error.message);

		const firstDraft = await runtime.handleContentUpdate("posts", created.data.item.id, {
			data: { hero: mediaRef("media-restored") },
		});
		expect(firstDraft.success).toBe(true);
		const revisionToRestore = (
			await revisionRepo.findByEntry("posts", created.data.item.id, { limit: 1 })
		)[0];
		expect(revisionToRestore).toBeDefined();
		const secondDraft = await runtime.handleContentUpdate("posts", created.data.item.id, {
			data: { hero: mediaRef("media-current-draft") },
		});
		expect(secondDraft.success).toBe(true);
		expect(await usageRepo.findCurrentUsageByMediaId("media-current-draft")).toHaveLength(1);

		const restored = await runtime.handleRevisionRestore(revisionToRestore!.id, "user-1");

		expect(restored.success).toBe(true);
		expect(await usageRepo.findCurrentUsageByMediaId("media-current-draft")).toEqual([]);
		expect(await usageRepo.findCurrentUsageByMediaId("media-restored")).toEqual([
			expect.objectContaining({
				source: expect.objectContaining({ sourceVariant: "draft_overlay" }),
			}),
		]);
	});

	it("refreshes usage when publishing a draft overlay", async () => {
		const created = await runtime.handleContentCreate("posts", {
			slug: "publish-post",
			data: {
				title: "Publish Post",
				hero: mediaRef("media-live"),
			},
		});
		expect(created.success).toBe(true);
		if (!created.success) throw new Error(created.error.message);
		await runtime.handleContentUpdate("posts", created.data.item.id, {
			data: { hero: mediaRef("media-draft") },
		});
		expect(await usageRepo.findCurrentUsageByMediaId("media-draft")).toEqual([
			expect.objectContaining({
				source: expect.objectContaining({ sourceVariant: "draft_overlay" }),
			}),
		]);

		const published = await runtime.handleContentPublish("posts", created.data.item.id);

		expect(published.success).toBe(true);
		expect(
			await usageRepo.findSource(sourceKey("posts", created.data.item.id, "draft_overlay")),
		).toBeNull();
		expect(await usageRepo.findCurrentUsageByMediaId("media-live")).toEqual([]);
		expect(await usageRepo.findCurrentUsageByMediaId("media-draft")).toEqual([
			expect.objectContaining({ source: expect.objectContaining({ sourceVariant: "columns" }) }),
		]);
	});

	it("refreshes usage when unpublishing creates a draft overlay", async () => {
		const created = await runtime.handleContentCreate("posts", {
			slug: "unpublish-post",
			data: {
				title: "Unpublish Post",
				hero: mediaRef("media-unpublish"),
			},
		});
		expect(created.success).toBe(true);
		if (!created.success) throw new Error(created.error.message);
		const published = await runtime.handleContentPublish("posts", created.data.item.id);
		expect(published.success).toBe(true);

		const unpublished = await runtime.handleContentUnpublish("posts", created.data.item.id);

		expect(unpublished.success).toBe(true);
		expect(await usageRepo.findSource(sourceKey("posts", created.data.item.id, "columns"))).toEqual(
			expect.objectContaining({ contentStatus: "draft", sourceVariant: "columns" }),
		);
		expect(
			await usageRepo.findSource(sourceKey("posts", created.data.item.id, "draft_overlay")),
		).toEqual(expect.objectContaining({ contentStatus: "draft", sourceVariant: "draft_overlay" }));
		expect(await usageRepo.findCurrentUsageByMediaId("media-unpublish")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ source: expect.objectContaining({ sourceVariant: "columns" }) }),
				expect.objectContaining({
					source: expect.objectContaining({ sourceVariant: "draft_overlay" }),
				}),
			]),
		);
	});

	it("refreshes schedule metadata on schedule and unschedule", async () => {
		const created = await runtime.handleContentCreate("plain_posts", {
			slug: "scheduled-post",
			data: {
				title: "Scheduled Post",
				hero: mediaRef("media-schedule"),
			},
		});
		expect(created.success).toBe(true);
		if (!created.success) throw new Error(created.error.message);
		const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();

		const scheduled = await runtime.handleContentSchedule(
			"plain_posts",
			created.data.item.id,
			scheduledAt,
		);

		expect(scheduled.success).toBe(true);
		expect(
			await usageRepo.findSource(sourceKey("plain_posts", created.data.item.id, "columns")),
		).toEqual(
			expect.objectContaining({
				contentStatus: "scheduled",
				contentScheduledAt: scheduledAt,
			}),
		);

		const unscheduled = await runtime.handleContentUnschedule("plain_posts", created.data.item.id);

		expect(unscheduled.success).toBe(true);
		expect(
			await usageRepo.findSource(sourceKey("plain_posts", created.data.item.id, "columns")),
		).toEqual(
			expect.objectContaining({
				contentStatus: "draft",
				contentScheduledAt: null,
			}),
		);
	});

	it("refreshes usage when discarding a draft overlay", async () => {
		const created = await runtime.handleContentCreate("posts", {
			slug: "discard-post",
			data: {
				title: "Discard Post",
				hero: mediaRef("media-live"),
			},
		});
		expect(created.success).toBe(true);
		if (!created.success) throw new Error(created.error.message);
		await runtime.handleContentUpdate("posts", created.data.item.id, {
			data: { hero: mediaRef("media-discard") },
		});
		expect(
			await usageRepo.findSource(sourceKey("posts", created.data.item.id, "draft_overlay")),
		).not.toBeNull();

		const discarded = await runtime.handleContentDiscardDraft("posts", created.data.item.id);

		expect(discarded.success).toBe(true);
		expect(
			await usageRepo.findSource(sourceKey("posts", created.data.item.id, "draft_overlay")),
		).toBeNull();
		expect(await usageRepo.findCurrentUsageByMediaId("media-discard")).toEqual([]);
		expect(await usageRepo.findCurrentUsageByMediaId("media-live")).toEqual([
			expect.objectContaining({ source: expect.objectContaining({ sourceVariant: "columns" }) }),
		]);
	});

	it("refreshes usage when scheduled publish runs through the runtime", async () => {
		const created = await runtime.handleContentCreate("posts", {
			slug: "scheduled-publish-post",
			data: {
				title: "Scheduled Publish Post",
				hero: mediaRef("media-live"),
			},
		});
		expect(created.success).toBe(true);
		if (!created.success) throw new Error(created.error.message);
		await runtime.handleContentUpdate("posts", created.data.item.id, {
			data: { hero: mediaRef("media-scheduled-draft") },
		});
		const dueAt = new Date(Date.now() - 60_000).toISOString();
		await sql`
			UPDATE ${sql.ref("ec_posts")}
			SET status = ${"scheduled"},
				scheduled_at = ${dueAt}
			WHERE id = ${created.data.item.id}
		`.execute(ctx.db);

		const result = await runtime.publishScheduled();

		expect(result).toEqual([{ collection: "posts", id: created.data.item.id }]);
		expect(
			await usageRepo.findSource(sourceKey("posts", created.data.item.id, "draft_overlay")),
		).toBeNull();
		expect(await usageRepo.findCurrentUsageByMediaId("media-live")).toEqual([]);
		expect(await usageRepo.findCurrentUsageByMediaId("media-scheduled-draft")).toEqual([
			expect.objectContaining({ source: expect.objectContaining({ sourceVariant: "columns" }) }),
		]);
	});

	it("refreshes trash metadata while preserving usage on soft delete", async () => {
		const created = await runtime.handleContentCreate("posts", {
			slug: "trashed-post",
			data: {
				title: "Trashed Post",
				hero: mediaRef("media-live-trash"),
			},
		});
		expect(created.success).toBe(true);
		if (!created.success) throw new Error(created.error.message);
		await runtime.handleContentUpdate("posts", created.data.item.id, {
			data: { hero: mediaRef("media-draft-trash") },
		});

		const deleted = await runtime.handleContentDelete("posts", "trashed-post");

		expect(deleted.success).toBe(true);
		if (!deleted.success) throw new Error(deleted.error.message);
		expect(deleted.data.id).toBe(created.data.item.id);
		expect(await usageRepo.findSource(sourceKey("posts", created.data.item.id, "columns"))).toEqual(
			expect.objectContaining({
				contentDeletedAt: expect.any(String),
				sourceVariant: "columns",
			}),
		);
		expect(
			await usageRepo.findSource(sourceKey("posts", created.data.item.id, "draft_overlay")),
		).toEqual(
			expect.objectContaining({
				contentDeletedAt: expect.any(String),
				sourceVariant: "draft_overlay",
			}),
		);
		expect(await usageRepo.findCurrentUsageByMediaId("media-live-trash")).toEqual([
			expect.objectContaining({ source: expect.objectContaining({ sourceVariant: "columns" }) }),
		]);
		expect(await usageRepo.findCurrentUsageByMediaId("media-draft-trash")).toEqual([
			expect.objectContaining({
				source: expect.objectContaining({ sourceVariant: "draft_overlay" }),
			}),
		]);
	});

	it("refreshes trash metadata when restoring content", async () => {
		const created = await runtime.handleContentCreate("posts", {
			slug: "restore-trash-post",
			data: {
				title: "Restore Trash Post",
				hero: mediaRef("media-live-restore"),
			},
		});
		expect(created.success).toBe(true);
		if (!created.success) throw new Error(created.error.message);
		await runtime.handleContentUpdate("posts", created.data.item.id, {
			data: { hero: mediaRef("media-draft-restore") },
		});
		const deleted = await runtime.handleContentDelete("posts", created.data.item.id);
		expect(deleted.success).toBe(true);
		expect(
			await usageRepo.findSource(sourceKey("posts", created.data.item.id, "draft_overlay")),
		).toEqual(expect.objectContaining({ contentDeletedAt: expect.any(String) }));

		const restored = await runtime.handleContentRestore("posts", "restore-trash-post");

		expect(restored.success).toBe(true);
		expect(await usageRepo.findSource(sourceKey("posts", created.data.item.id, "columns"))).toEqual(
			expect.objectContaining({
				contentDeletedAt: null,
				sourceVariant: "columns",
			}),
		);
		expect(
			await usageRepo.findSource(sourceKey("posts", created.data.item.id, "draft_overlay")),
		).toEqual(
			expect.objectContaining({
				contentDeletedAt: null,
				sourceVariant: "draft_overlay",
			}),
		);
		expect(await usageRepo.findCurrentUsageByMediaId("media-live-restore")).toEqual([
			expect.objectContaining({ source: expect.objectContaining({ sourceVariant: "columns" }) }),
		]);
		expect(await usageRepo.findCurrentUsageByMediaId("media-draft-restore")).toEqual([
			expect.objectContaining({
				source: expect.objectContaining({ sourceVariant: "draft_overlay" }),
			}),
		]);
	});

	it("deletes usage sources and current occurrences on permanent delete", async () => {
		const created = await runtime.handleContentCreate("posts", {
			slug: "permanent-delete-post",
			data: {
				title: "Permanent Delete Post",
				hero: mediaRef("media-live-permanent"),
			},
		});
		expect(created.success).toBe(true);
		if (!created.success) throw new Error(created.error.message);
		await runtime.handleContentUpdate("posts", created.data.item.id, {
			data: { hero: mediaRef("media-draft-permanent") },
		});
		const deleted = await runtime.handleContentDelete("posts", created.data.item.id);
		expect(deleted.success).toBe(true);

		const permanentlyDeleted = await runtime.handleContentPermanentDelete(
			"posts",
			"permanent-delete-post",
		);

		expect(permanentlyDeleted.success).toBe(true);
		if (!permanentlyDeleted.success) throw new Error(permanentlyDeleted.error.message);
		expect(permanentlyDeleted.data.id).toBe(created.data.item.id);
		expect(
			await usageRepo.findSource(sourceKey("posts", created.data.item.id, "columns")),
		).toBeNull();
		expect(
			await usageRepo.findSource(sourceKey("posts", created.data.item.id, "draft_overlay")),
		).toBeNull();
		expect(await usageRepo.findCurrentUsageByMediaId("media-live-permanent")).toEqual([]);
		expect(await usageRepo.findCurrentUsageByMediaId("media-draft-permanent")).toEqual([]);
	});

	it("refreshes i18n siblings when a non-translatable image syncs across locales", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		const { enId, frId } = await createLocalizedPostsPair(runtime, "shared-image", {
			enSharedHero: "media-shared-old-en",
			frSharedHero: "media-shared-old-fr",
		});

		const updated = await runtime.handleContentUpdate("localized_posts", enId, {
			data: { shared_hero: mediaRef("media-shared-new") },
		});

		expect(updated.success).toBe(true);
		expect(await usageRepo.findCurrentUsageByMediaId("media-shared-old-en")).toEqual([]);
		expect(await usageRepo.findCurrentUsageByMediaId("media-shared-old-fr")).toEqual([]);
		expect(await usageRepo.findCurrentUsageByMediaId("media-shared-new")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: expect.objectContaining({ contentId: enId, sourceVariant: "columns" }),
					occurrence: expect.objectContaining({ fieldPath: "shared_hero" }),
				}),
				expect.objectContaining({
					source: expect.objectContaining({ contentId: frId, sourceVariant: "columns" }),
					occurrence: expect.objectContaining({ fieldPath: "shared_hero" }),
				}),
			]),
		);
	});

	it("does not refresh i18n siblings for translatable image updates", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		const { enId, frId } = await createLocalizedPostsPair(runtime, "translatable-image", {
			enHero: "media-hero-old-en",
			frHero: "media-hero-old-fr",
		});
		const frSourceBefore = await usageRepo.findSource(
			sourceKey("localized_posts", frId, "columns"),
		);
		expect(frSourceBefore).not.toBeNull();

		const updated = await runtime.handleContentUpdate("localized_posts", enId, {
			data: { hero: mediaRef("media-hero-new-en") },
		});

		expect(updated.success).toBe(true);
		expect(await usageRepo.findCurrentUsageByMediaId("media-hero-new-en")).toEqual([
			expect.objectContaining({
				source: expect.objectContaining({ contentId: enId, sourceVariant: "columns" }),
			}),
		]);
		expect(await usageRepo.findCurrentUsageByMediaId("media-hero-old-fr")).toEqual([
			expect.objectContaining({
				source: expect.objectContaining({ contentId: frId, sourceVariant: "columns" }),
			}),
		]);
		expect(
			(await usageRepo.findSource(sourceKey("localized_posts", frId, "columns")))
				?.currentGeneration,
		).toBe(frSourceBefore?.currentGeneration);
	});

	it("does not refresh i18n siblings for non-usage non-translatable updates", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		const { enId, frId } = await createLocalizedPostsPair(runtime, "non-usage-sync");
		const frSourceBefore = await usageRepo.findSource(
			sourceKey("localized_posts", frId, "columns"),
		);
		expect(frSourceBefore).not.toBeNull();

		const updated = await runtime.handleContentUpdate("localized_posts", enId, {
			data: { summary: "Shared summary" },
		});

		expect(updated.success).toBe(true);
		expect(
			(await usageRepo.findSource(sourceKey("localized_posts", frId, "columns")))
				?.currentGeneration,
		).toBe(frSourceBefore?.currentGeneration);
	});

	it("does not refresh i18n siblings for revision-enabled draft saves", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		const en = await runtime.handleContentCreate("posts", {
			slug: "draft-sibling-en",
			locale: "en",
			data: {
				title: "English Draft Sibling",
				shared_hero: mediaRef("media-draft-sibling-old-en"),
			},
		});
		expect(en.success).toBe(true);
		if (!en.success) throw new Error(en.error.message);
		const fr = await runtime.handleContentCreate("posts", {
			slug: "draft-sibling-fr",
			locale: "fr",
			translationOf: en.data.item.id,
			data: {
				title: "French Draft Sibling",
				shared_hero: mediaRef("media-draft-sibling-old-fr"),
			},
		});
		expect(fr.success).toBe(true);
		if (!fr.success) throw new Error(fr.error.message);
		const frSourceBefore = await usageRepo.findSource(
			sourceKey("posts", fr.data.item.id, "columns"),
		);
		expect(frSourceBefore).not.toBeNull();

		const updated = await runtime.handleContentUpdate("posts", en.data.item.id, {
			data: { shared_hero: mediaRef("media-draft-sibling-new") },
		});

		expect(updated.success).toBe(true);
		expect(await usageRepo.findCurrentUsageByMediaId("media-draft-sibling-new")).toEqual([
			expect.objectContaining({
				source: expect.objectContaining({
					contentId: en.data.item.id,
					sourceVariant: "draft_overlay",
				}),
			}),
		]);
		expect(await usageRepo.findCurrentUsageByMediaId("media-draft-sibling-old-fr")).toEqual([
			expect.objectContaining({
				source: expect.objectContaining({
					contentId: fr.data.item.id,
					sourceVariant: "columns",
				}),
			}),
		]);
		expect(
			(await usageRepo.findSource(sourceKey("posts", fr.data.item.id, "columns")))
				?.currentGeneration,
		).toBe(frSourceBefore?.currentGeneration);
	});

	it("refreshes trashed i18n siblings when non-translatable fields sync to them", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		const { enId, frId } = await createLocalizedPostsPair(runtime, "trashed-sibling", {
			enSharedHero: "media-trash-old-en",
			frSharedHero: "media-trash-old-fr",
		});
		const deleted = await runtime.handleContentDelete("localized_posts", frId);
		expect(deleted.success).toBe(true);

		const updated = await runtime.handleContentUpdate("localized_posts", enId, {
			data: { shared_hero: mediaRef("media-trash-new") },
		});

		expect(updated.success).toBe(true);
		expect(await usageRepo.findCurrentUsageByMediaId("media-trash-old-fr")).toEqual([]);
		expect(await usageRepo.findSource(sourceKey("localized_posts", frId, "columns"))).toEqual(
			expect.objectContaining({
				contentDeletedAt: expect.any(String),
				contentId: frId,
			}),
		);
		expect(await usageRepo.findCurrentUsageByMediaId("media-trash-new")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: expect.objectContaining({ contentId: enId, contentDeletedAt: null }),
				}),
				expect.objectContaining({
					source: expect.objectContaining({
						contentId: frId,
						contentDeletedAt: expect.any(String),
					}),
				}),
			]),
		);
	});

	it("refreshes i18n sibling source metadata for non-translatable display fields", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		const { enId, frId } = await createLocalizedPostsPair(runtime, "shared-title", {
			enTitle: "English Title",
			frTitle: "French Title",
		});

		const updated = await runtime.handleContentUpdate("localized_posts", enId, {
			data: { title: "Shared Title" },
		});

		expect(updated.success).toBe(true);
		expect(await usageRepo.findSource(sourceKey("localized_posts", enId, "columns"))).toEqual(
			expect.objectContaining({ contentTitle: "Shared Title" }),
		);
		expect(await usageRepo.findSource(sourceKey("localized_posts", frId, "columns"))).toEqual(
			expect.objectContaining({ contentTitle: "Shared Title" }),
		);
	});
});

async function createLocalizedPostsPair(
	runtime: EmDashRuntime,
	slugPrefix: string,
	input: {
		enTitle?: string;
		frTitle?: string;
		enHero?: string;
		frHero?: string;
		enSharedHero?: string;
		frSharedHero?: string;
	} = {},
): Promise<{ enId: string; frId: string }> {
	const en = await runtime.handleContentCreate("localized_posts", {
		slug: `${slugPrefix}-en`,
		locale: "en",
		data: {
			title: input.enTitle ?? "English Post",
			hero: mediaRef(input.enHero ?? `${slugPrefix}-hero-en`),
			shared_hero: mediaRef(input.enSharedHero ?? `${slugPrefix}-shared-en`),
		},
	});
	expect(en.success).toBe(true);
	if (!en.success) throw new Error(en.error.message);

	const fr = await runtime.handleContentCreate("localized_posts", {
		slug: `${slugPrefix}-fr`,
		locale: "fr",
		translationOf: en.data.item.id,
		data: {
			title: input.frTitle ?? "French Post",
			hero: mediaRef(input.frHero ?? `${slugPrefix}-hero-fr`),
			shared_hero: mediaRef(input.frSharedHero ?? `${slugPrefix}-shared-fr`),
		},
	});
	expect(fr.success).toBe(true);
	if (!fr.success) throw new Error(fr.error.message);

	return { enId: en.data.item.id, frId: fr.data.item.id };
}

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
	sourceVariant: "columns" | "draft_overlay",
): string {
	return buildContentMediaUsageSourceKey({ collectionSlug, contentId, sourceVariant });
}

async function corruptFuturePostDraftRevisionSnapshots(ctx: DialectTestContext): Promise<void> {
	if (ctx.dialect === "postgres") {
		await sql`
			CREATE FUNCTION corrupt_posts_draft_revision()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				IF NEW.draft_revision_id IS NOT NULL THEN
					UPDATE revisions SET data = '{' WHERE id = NEW.draft_revision_id;
				END IF;
				RETURN NEW;
			END;
			$$
		`.execute(ctx.db);
		await sql`
			CREATE TRIGGER corrupt_posts_draft_revision
			AFTER UPDATE OF draft_revision_id ON ec_posts
			FOR EACH ROW
			EXECUTE FUNCTION corrupt_posts_draft_revision()
		`.execute(ctx.db);
		return;
	}

	await sql`
		CREATE TRIGGER corrupt_posts_draft_revision
		AFTER UPDATE OF draft_revision_id ON ec_posts
		WHEN NEW.draft_revision_id IS NOT NULL
		BEGIN
			UPDATE revisions SET data = '{' WHERE id = NEW.draft_revision_id;
		END
	`.execute(ctx.db);
}
