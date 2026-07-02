import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
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
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "hero", label: "Hero", type: "image" });
		await registry.createCollection({ slug: "plain_posts", label: "Plain Posts", supports: [] });
		await registry.createField("plain_posts", {
			slug: "title",
			label: "Title",
			type: "string",
		});
		await registry.createField("plain_posts", { slug: "hero", label: "Hero", type: "image" });

		runtime = createTestRuntime(ctx.db);
		usageRepo = new MediaUsageRepository(ctx.db);
		revisionRepo = new RevisionRepository(ctx.db);
	});

	afterEach(async () => {
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
	sourceVariant: "columns" | "draft_overlay",
): string {
	return buildContentMediaUsageSourceKey({ collectionSlug, contentId, sourceVariant });
}
