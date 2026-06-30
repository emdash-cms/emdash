import { afterEach, beforeEach, expect, it } from "vitest";

import {
	handleContentCreate,
	handleContentDelete,
	handleContentDiscardDraft,
	handleContentPermanentDelete,
	handleContentDuplicate,
	handleContentPublish,
	handleContentRestore,
	handleContentSchedule,
	handleContentUnschedule,
	handleContentUnpublish,
	handleContentUpdate,
} from "../../../src/api/handlers/content.js";
import { handleRevisionRestore } from "../../../src/api/handlers/revision.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import { MediaRepository, type MediaItem } from "../../../src/database/repositories/media.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { replaceContentMediaUsage } from "../../../src/media/usage-index.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

function compareNullableString(a: string | null, b: string | null): number {
	return (a ?? "").localeCompare(b ?? "");
}

describeEachDialect("content media usage indexing", (dialect) => {
	let ctx: DialectTestContext;
	let mediaA: MediaItem;
	let mediaB: MediaItem;
	let fileMedia: MediaItem;
	let bodyMedia: MediaItem;
	let galleryMedia: MediaItem;
	let usageRepo: MediaUsageRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		usageRepo = new MediaUsageRepository(ctx.db);
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });

		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({
			slug: "posts",
			label: "Posts",
			labelSingular: "Post",
			supports: ["revisions"],
		});
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", {
			slug: "hero",
			label: "Hero",
			type: "image",
			translatable: false,
		});
		await registry.createField("posts", { slug: "attachment", label: "Attachment", type: "file" });
		await registry.createField("posts", { slug: "body", label: "Body", type: "portableText" });
		await registry.createField("posts", {
			slug: "gallery",
			label: "Gallery",
			type: "repeater",
			validation: { subFields: [{ slug: "image", label: "Image", type: "image" }] },
		});

		const mediaRepo = new MediaRepository(ctx.db);
		mediaA = await mediaRepo.create({
			filename: "a.jpg",
			mimeType: "image/jpeg",
			storageKey: "a.jpg",
		});
		mediaB = await mediaRepo.create({
			filename: "b.jpg",
			mimeType: "image/jpeg",
			storageKey: "b.jpg",
		});
		fileMedia = await mediaRepo.create({
			filename: "doc.pdf",
			mimeType: "application/pdf",
			storageKey: "doc.pdf",
		});
		bodyMedia = await mediaRepo.create({
			filename: "body.jpg",
			mimeType: "image/jpeg",
			storageKey: "body.jpg",
		});
		galleryMedia = await mediaRepo.create({
			filename: "gallery.jpg",
			mimeType: "image/jpeg",
			storageKey: "gallery.jpg",
		});
	});

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(ctx);
	});

	it("indexes media usage on content create", async () => {
		const created = await createPostWithMedia(mediaA.id);
		expect(created.success).toBe(true);

		expect((await usageRepo.findCurrentByMediaId(mediaA.id))[0]?.fieldPath).toBe("hero");
		expect((await usageRepo.findCurrentByMediaId(mediaA.id))[0]?.state).toBe("draft");
		expect((await usageRepo.findCurrentByMediaId(fileMedia.id))[0]?.fieldPath).toBe("attachment");
		expect((await usageRepo.findCurrentByMediaId(bodyMedia.id))[0]?.fieldPath).toBe(
			"body[0].asset._ref",
		);
		expect((await usageRepo.findCurrentByMediaId(galleryMedia.id))[0]?.fieldPath).toBe(
			"gallery[0].image",
		);
	});

	it("indexes structured provider media references", async () => {
		const created = await handleContentCreate(ctx.db, "posts", {
			slug: "provider-media",
			data: {
				title: "Provider Media",
				hero: {
					id: "cf_image_1",
					provider: "cloudflare-images",
					mimeType: "image/webp",
				},
				attachment: { id: "mux_asset_1", provider: "mux", mimeType: "video/mp4" },
			},
		});
		expect(created.success).toBe(true);

		expect(await usageRepo.findCurrentByMediaId("cf_image_1")).toHaveLength(0);
		const imageUsage = await usageRepo.findCurrentByProviderAsset(
			"cloudflare-images",
			"cf_image_1",
		);
		expect(imageUsage).toHaveLength(1);
		expect(imageUsage[0]?.mediaId).toBeNull();
		expect(imageUsage[0]?.mediaKind).toBe("image");
		expect(imageUsage[0]?.mimeType).toBe("image/webp");

		const videoUsage = await usageRepo.findCurrentByProviderAsset("mux", "mux_asset_1");
		expect(videoUsage).toHaveLength(1);
		expect(videoUsage[0]?.mediaKind).toBe("video");
		expect(videoUsage[0]?.fieldPath).toBe("attachment");
	});

	it("replaces stale usage on content update", async () => {
		const created = await createPostWithMedia(mediaA.id);
		if (!created.success) throw new Error("create failed");

		const updated = await handleContentUpdate(ctx.db, "posts", created.data.item.id, {
			data: { hero: { id: mediaB.id, provider: "local" } },
		});
		expect(updated.success).toBe(true);

		expect(await usageRepo.findCurrentByMediaId(mediaA.id)).toHaveLength(0);
		expect((await usageRepo.findCurrentByMediaId(mediaB.id))[0]?.fieldPath).toBe("hero");
	});

	it("refreshes usage metadata on slug-only update", async () => {
		const created = await createPostWithMedia(mediaA.id);
		if (!created.success) throw new Error("create failed");

		const updated = await handleContentUpdate(ctx.db, "posts", created.data.item.id, {
			slug: "renamed-post",
		});
		expect(updated.success).toBe(true);

		const mediaAUsage = await usageRepo.findCurrentByMediaId(mediaA.id);
		expect(mediaAUsage).toHaveLength(1);
		expect(mediaAUsage[0]?.contentSlug).toBe("renamed-post");
	});

	it("removes stale old-state usage on direct status update", async () => {
		const created = await createPostWithMedia(mediaA.id);
		if (!created.success) throw new Error("create failed");
		const published = await handleContentPublish(ctx.db, "posts", created.data.item.id);
		expect(published.success).toBe(true);

		const updated = await handleContentUpdate(ctx.db, "posts", created.data.item.id, {
			status: "draft",
		});
		expect(updated.success).toBe(true);

		const mediaAUsage = await usageRepo.findCurrentByMediaId(mediaA.id);
		expect(mediaAUsage).toHaveLength(1);
		expect(mediaAUsage[0]?.state).toBe("draft");
	});

	it("keeps live usage while staged draft usage changes, then promotes on publish", async () => {
		const created = await createPostWithMedia(mediaA.id);
		if (!created.success) throw new Error("create failed");
		const initialPublish = await handleContentPublish(ctx.db, "posts", created.data.item.id);
		expect(initialPublish.success).toBe(true);

		const contentRepo = new ContentRepository(ctx.db);
		const revisionRepo = new RevisionRepository(ctx.db);
		const draftData = { title: "Draft", hero: { id: mediaB.id, provider: "local" } };
		const draft = await revisionRepo.create({
			collection: "posts",
			entryId: created.data.item.id,
			data: draftData,
		});
		await contentRepo.setDraftRevision("posts", created.data.item.id, draft.id);
		const staged = await contentRepo.findById("posts", created.data.item.id);
		if (!staged) throw new Error("staged item missing");
		await replaceContentMediaUsage(ctx.db, "posts", staged, "draft", draftData, draft.id);

		expect((await usageRepo.findCurrentByMediaId(mediaA.id))[0]?.state).toBe("live");
		expect((await usageRepo.findCurrentByMediaId(mediaB.id))[0]?.state).toBe("draft");

		const published = await handleContentPublish(ctx.db, "posts", created.data.item.id);
		expect(published.success).toBe(true);

		expect(await usageRepo.findCurrentByMediaId(mediaA.id)).toHaveLength(0);
		const mediaBUsage = await usageRepo.findCurrentByMediaId(mediaB.id);
		expect(mediaBUsage).toHaveLength(1);
		expect(mediaBUsage[0]?.state).toBe("live");
	});

	it("clears draft usage on discard draft", async () => {
		const created = await createPostWithMedia(mediaA.id);
		if (!created.success) throw new Error("create failed");

		const contentRepo = new ContentRepository(ctx.db);
		const revisionRepo = new RevisionRepository(ctx.db);
		const draftData = { title: "Draft", hero: { id: mediaB.id, provider: "local" } };
		const draft = await revisionRepo.create({
			collection: "posts",
			entryId: created.data.item.id,
			data: draftData,
		});
		await contentRepo.setDraftRevision("posts", created.data.item.id, draft.id);
		const staged = await contentRepo.findById("posts", created.data.item.id);
		if (!staged) throw new Error("staged item missing");
		await replaceContentMediaUsage(ctx.db, "posts", staged, "draft", draftData, draft.id);

		const discarded = await handleContentDiscardDraft(ctx.db, "posts", created.data.item.id);
		expect(discarded.success).toBe(true);

		expect((await usageRepo.findCurrentByMediaId(mediaA.id))[0]?.state).toBe("draft");
		expect(await usageRepo.findCurrentByMediaId(mediaB.id)).toHaveLength(0);
	});

	it("reindexes sibling locales when non-translatable media fields sync", async () => {
		const en = await handleContentCreate(ctx.db, "posts", {
			slug: "shared-en",
			locale: "en",
			data: { title: "Shared", hero: { id: mediaA.id, provider: "local" } },
		});
		if (!en.success) throw new Error("create en failed");
		const fr = await handleContentCreate(ctx.db, "posts", {
			slug: "shared-fr",
			locale: "fr",
			translationOf: en.data.item.id,
			data: { title: "Partage", hero: { id: mediaA.id, provider: "local" } },
		});
		if (!fr.success) throw new Error("create fr failed");

		const updated = await handleContentUpdate(ctx.db, "posts", en.data.item.id, {
			data: { hero: { id: mediaB.id, provider: "local" } },
		});
		expect(updated.success).toBe(true);

		expect(await usageRepo.findCurrentByMediaId(mediaA.id)).toHaveLength(0);
		const mediaBUsage = await usageRepo.findCurrentByMediaId(mediaB.id);
		expect(mediaBUsage.map((usage) => usage.contentId).toSorted(compareNullableString)).toEqual(
			[en.data.item.id, fr.data.item.id].toSorted(compareNullableString),
		);
	});

	it("updates live usage when restoring a revision through the handler path", async () => {
		const created = await createPostWithMedia(mediaA.id);
		if (!created.success) throw new Error("create failed");
		const published = await handleContentPublish(ctx.db, "posts", created.data.item.id);
		expect(published.success).toBe(true);
		const revisionRepo = new RevisionRepository(ctx.db);
		const revision = await revisionRepo.create({
			collection: "posts",
			entryId: created.data.item.id,
			data: { title: "Restored", hero: { id: mediaB.id, provider: "local" } },
		});

		const restored = await handleRevisionRestore(ctx.db, revision.id, "user1");
		expect(restored.success).toBe(true);

		expect(await usageRepo.findCurrentByMediaId(mediaA.id)).toHaveLength(0);
		const mediaBUsage = await usageRepo.findCurrentByMediaId(mediaB.id);
		expect(mediaBUsage).toHaveLength(1);
		expect(mediaBUsage[0]?.state).toBe("live");
	});

	it("moves published usage to draft when content is unpublished", async () => {
		const created = await createPostWithMedia(mediaA.id);
		if (!created.success) throw new Error("create failed");
		const published = await handleContentPublish(ctx.db, "posts", created.data.item.id);
		expect(published.success).toBe(true);

		const unpublished = await handleContentUnpublish(ctx.db, "posts", created.data.item.id);
		expect(unpublished.success).toBe(true);

		const mediaAUsage = await usageRepo.findCurrentByMediaId(mediaA.id);
		expect(mediaAUsage).toHaveLength(1);
		expect(mediaAUsage[0]?.state).toBe("draft");
	});

	it("keeps draft usage when published content without revisions is unpublished", async () => {
		const created = await handleContentCreate(ctx.db, "posts", {
			slug: "direct-published",
			status: "published",
			data: { title: "Published", hero: { id: mediaA.id, provider: "local" } },
		});
		if (!created.success) throw new Error("create failed");
		expect(created.data.item.liveRevisionId).toBeNull();
		expect(created.data.item.draftRevisionId).toBeNull();

		const unpublished = await handleContentUnpublish(ctx.db, "posts", created.data.item.id);
		expect(unpublished.success).toBe(true);

		const mediaAUsage = await usageRepo.findCurrentByMediaId(mediaA.id);
		expect(mediaAUsage).toHaveLength(1);
		expect(mediaAUsage[0]?.state).toBe("draft");
	});

	it("refreshes usage status metadata on schedule and unschedule", async () => {
		const created = await createPostWithMedia(mediaA.id);
		if (!created.success) throw new Error("create failed");

		const scheduledAt = new Date(Date.now() + 60_000).toISOString();
		const scheduled = await handleContentSchedule(
			ctx.db,
			"posts",
			created.data.item.id,
			scheduledAt,
		);
		expect(scheduled.success).toBe(true);
		let mediaAUsage = await usageRepo.findCurrentByMediaId(mediaA.id);
		expect(mediaAUsage[0]?.state).toBe("draft");
		expect(mediaAUsage[0]?.contentStatus).toBe("scheduled");

		const unscheduled = await handleContentUnschedule(ctx.db, "posts", created.data.item.id);
		expect(unscheduled.success).toBe(true);
		mediaAUsage = await usageRepo.findCurrentByMediaId(mediaA.id);
		expect(mediaAUsage[0]?.contentStatus).toBe("draft");
	});

	it("refreshes usage deleted metadata on soft delete and restore", async () => {
		const created = await createPostWithMedia(mediaA.id);
		if (!created.success) throw new Error("create failed");

		const deleted = await handleContentDelete(ctx.db, "posts", created.data.item.id);
		expect(deleted.success).toBe(true);
		let mediaAUsage = await usageRepo.findCurrentByMediaId(mediaA.id);
		expect(mediaAUsage[0]?.contentDeletedAt).toBeTruthy();

		const restored = await handleContentRestore(ctx.db, "posts", created.data.item.id);
		expect(restored.success).toBe(true);
		mediaAUsage = await usageRepo.findCurrentByMediaId(mediaA.id);
		expect(mediaAUsage[0]?.contentDeletedAt).toBeNull();
	});

	it("indexes media usage for duplicated content", async () => {
		const created = await createPostWithMedia(mediaA.id);
		if (!created.success) throw new Error("create failed");

		const duplicated = await handleContentDuplicate(ctx.db, "posts", created.data.item.id);
		expect(duplicated.success).toBe(true);

		const mediaAUsage = await usageRepo.findCurrentByMediaId(mediaA.id);
		expect(mediaAUsage.map((usage) => usage.contentId).toSorted(compareNullableString)).toEqual(
			[created.data.item.id, duplicated.data.item.id].toSorted(compareNullableString),
		);
	});

	it("clears usage when a media-bearing field is deleted", async () => {
		const created = await createPostWithMedia(mediaA.id);
		if (!created.success) throw new Error("create failed");

		await new SchemaRegistry(ctx.db).deleteField("posts", "hero");

		expect(await usageRepo.findCurrentByMediaId(mediaA.id)).toHaveLength(0);
		expect(await usageRepo.findCurrentByMediaId(fileMedia.id)).toHaveLength(1);
	});

	it("clears usage when a media-bearing field changes to a non-media type", async () => {
		const created = await createPostWithMedia(mediaA.id);
		if (!created.success) throw new Error("create failed");

		await new SchemaRegistry(ctx.db).updateField("posts", "hero", { type: "string" });

		expect(await usageRepo.findCurrentByMediaId(mediaA.id)).toHaveLength(0);
	});

	it("clears usage when a collection is force-deleted", async () => {
		const created = await createPostWithMedia(mediaA.id);
		if (!created.success) throw new Error("create failed");

		await new SchemaRegistry(ctx.db).deleteCollection("posts", { force: true });

		expect(await usageRepo.findCurrentByMediaId(mediaA.id)).toHaveLength(0);
	});

	it("clears usage on permanent delete", async () => {
		const created = await createPostWithMedia(mediaA.id);
		if (!created.success) throw new Error("create failed");

		const deleted = await handleContentDelete(ctx.db, "posts", created.data.item.id);
		expect(deleted.success).toBe(true);

		const permanentlyDeleted = await handleContentPermanentDelete(
			ctx.db,
			"posts",
			created.data.item.id,
		);
		expect(permanentlyDeleted.success).toBe(true);
		expect(await usageRepo.findCurrentByMediaId(mediaA.id)).toHaveLength(0);
	});

	function createPostWithMedia(heroMediaId: string) {
		return handleContentCreate(ctx.db, "posts", {
			slug: `post-${heroMediaId}`,
			data: {
				title: "Hello",
				hero: { id: heroMediaId, provider: "local" },
				attachment: { id: fileMedia.id, provider: "local" },
				body: [
					{
						_type: "image",
						_key: "body-image",
						asset: { _ref: bodyMedia.id },
					},
				],
				gallery: [{ image: { id: galleryMedia.id, provider: "local" } }],
			},
		});
	}
});
