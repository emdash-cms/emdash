import { sql } from "kysely";
import { ulid } from "ulidx";
import { afterEach, beforeEach, expect, it } from "vitest";

import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import { loadContentMediaUsageSnapshots } from "../../../src/media/usage/content-snapshots.js";
import { buildContentMediaUsageSourceKey } from "../../../src/media/usage/source-key.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("content media usage snapshots", (dialect) => {
	let ctx: DialectTestContext;
	let registry: SchemaRegistry;
	let revisionRepo: RevisionRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		registry = new SchemaRegistry(ctx.db);
		revisionRepo = new RevisionRepository(ctx.db);

		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "hero", label: "Hero", type: "image" });
		await registry.createField("posts", { slug: "attachment", label: "Attachment", type: "file" });
		await registry.createField("posts", {
			slug: "sections",
			label: "Sections",
			type: "repeater",
			validation: { subFields: [{ slug: "image", type: "image", label: "Image" }] },
		});
		await registry.createField("posts", { slug: "body", label: "Body", type: "portableText" });
		await registry.createField("posts", { slug: "raw_data", label: "Raw Data", type: "json" });
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("builds a columns snapshot from stored content fields", async () => {
		const item = await insertPost(ctx, {
			slug: "hello-world",
			status: "published",
			locale: "en",
			data: {
				title: "Hello World",
				hero: { id: "media-hero", provider: "local", mimeType: "image/webp" },
				attachment: { id: "media-file", provider: "local", mimeType: "application/pdf" },
				sections: [{ image: { id: "media-section", provider: "local" } }],
				body: [{ _type: "image", asset: { _ref: "media-body" } }],
				raw_data: { id: "media-ignored" },
			},
		});

		const result = await loadContentMediaUsageSnapshots(ctx.db, "posts", item.id);

		expect(result.success).toBe(true);
		if (!result.success) throw new Error(result.error);
		expect(result.snapshots).toHaveLength(1);
		const snapshot = result.snapshots[0]!;

		expect(snapshot.source).toEqual(
			expect.objectContaining({
				sourceKey: buildContentMediaUsageSourceKey({
					collectionSlug: "posts",
					contentId: item.id,
					sourceVariant: "columns",
				}),
				sourceType: "content",
				collectionSlug: "posts",
				contentId: item.id,
				sourceVariant: "columns",
				locale: "en",
				translationGroup: item.translationGroup,
				contentSlug: "hello-world",
				contentTitle: "Hello World",
				contentStatus: "published",
				contentScheduledAt: null,
				contentDeletedAt: null,
				revisionId: null,
				sourceUpdatedAt: item.updatedAt,
				sourceVersion: item.version,
			}),
		);
		expect(snapshot.fields).toEqual([
			{ slug: "attachment", type: "file" },
			{ slug: "body", type: "portableText" },
			{ slug: "hero", type: "image" },
			{
				slug: "sections",
				type: "repeater",
				validation: { subFields: [{ slug: "image", type: "image" }] },
			},
		]);
		expect(snapshot.occurrences).toEqual([
			expect.objectContaining({ fieldPath: "attachment", mediaId: "media-file" }),
			expect.objectContaining({ fieldPath: "body[0].asset._ref", mediaId: "media-body" }),
			expect.objectContaining({ fieldPath: "hero", mediaId: "media-hero" }),
			expect.objectContaining({ fieldPath: "sections[0].image", mediaId: "media-section" }),
		]);
		expect(snapshot.occurrences).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ mediaId: "media-ignored" })]),
		);
	});

	it("returns a typed not-found result for missing content", async () => {
		const result = await loadContentMediaUsageSnapshots(ctx.db, "posts", "missing-content");

		expect(result).toEqual({ success: false, error: "CONTENT_NOT_FOUND" });
	});

	it("builds columns and draft overlay snapshots for a pending draft revision", async () => {
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
				_slug: "draft-post",
				title: "Draft Title",
				hero: { id: "media-draft", provider: "local", mimeType: "image/webp" },
			},
		});
		await setDraftRevision(ctx, item.id, draft.id);

		const result = await loadContentMediaUsageSnapshots(ctx.db, "posts", item.id);

		expect(result.success).toBe(true);
		if (!result.success) throw new Error(result.error);
		expect(result.snapshots.map((snapshot) => snapshot.source.sourceVariant)).toEqual([
			"columns",
			"draft_overlay",
		]);

		const columns = result.snapshots.find(
			(snapshot) => snapshot.source.sourceVariant === "columns",
		)!;
		const overlay = result.snapshots.find(
			(snapshot) => snapshot.source.sourceVariant === "draft_overlay",
		)!;

		expect(columns.source).toEqual(
			expect.objectContaining({
				contentSlug: "live-post",
				contentTitle: "Live Title",
				revisionId: null,
				sourceKey: buildContentMediaUsageSourceKey({
					collectionSlug: "posts",
					contentId: item.id,
					sourceVariant: "columns",
				}),
			}),
		);
		expect(columns.occurrences).toEqual([
			expect.objectContaining({ fieldPath: "hero", mediaId: "media-live" }),
		]);

		expect(overlay.source).toEqual(
			expect.objectContaining({
				contentSlug: "draft-post",
				contentTitle: "Draft Title",
				revisionId: draft.id,
				sourceKey: buildContentMediaUsageSourceKey({
					collectionSlug: "posts",
					contentId: item.id,
					sourceVariant: "draft_overlay",
				}),
			}),
		);
		expect(overlay.occurrences).toEqual([
			expect.objectContaining({ fieldPath: "hero", mediaId: "media-draft" }),
		]);
	});

	it("merges draft overlays over columns when the draft changes unrelated fields", async () => {
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
			data: { title: "Draft Title" },
		});
		await setDraftRevision(ctx, item.id, draft.id);

		const result = await loadContentMediaUsageSnapshots(ctx.db, "posts", item.id);

		expect(result.success).toBe(true);
		if (!result.success) throw new Error(result.error);
		const overlay = result.snapshots.find(
			(snapshot) => snapshot.source.sourceVariant === "draft_overlay",
		)!;
		expect(overlay.source.contentTitle).toBe("Draft Title");
		expect(overlay.occurrences).toEqual([
			expect.objectContaining({ fieldPath: "hero", mediaId: "media-live" }),
		]);
	});

	it("preserves column display fields when a draft changes only media", async () => {
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

		const result = await loadContentMediaUsageSnapshots(ctx.db, "posts", item.id);

		expect(result.success).toBe(true);
		if (!result.success) throw new Error(result.error);
		const overlay = result.snapshots.find(
			(snapshot) => snapshot.source.sourceVariant === "draft_overlay",
		)!;
		expect(overlay.source.contentTitle).toBe("Live Title");
		expect(overlay.occurrences).toEqual([
			expect.objectContaining({ fieldPath: "hero", mediaId: "media-draft" }),
		]);
	});

	it("keeps JSON-looking revision display strings as strings", async () => {
		const item = await insertPost(ctx, {
			slug: "live-post",
			status: "published",
			data: { title: "Live Title" },
		});
		const draftTitle = '{"headline":"Draft"}';
		const draft = await revisionRepo.create({
			collection: "posts",
			entryId: item.id,
			data: { title: draftTitle },
		});
		await setDraftRevision(ctx, item.id, draft.id);

		const result = await loadContentMediaUsageSnapshots(ctx.db, "posts", item.id);

		expect(result.success).toBe(true);
		if (!result.success) throw new Error(result.error);
		const overlay = result.snapshots.find(
			(snapshot) => snapshot.source.sourceVariant === "draft_overlay",
		)!;
		expect(overlay.source.contentTitle).toBe(draftTitle);
	});

	it("honors draft nulls that clear media fields", async () => {
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
			data: { hero: null },
		});
		await setDraftRevision(ctx, item.id, draft.id);

		const result = await loadContentMediaUsageSnapshots(ctx.db, "posts", item.id);

		expect(result.success).toBe(true);
		if (!result.success) throw new Error(result.error);
		const overlay = result.snapshots.find(
			(snapshot) => snapshot.source.sourceVariant === "draft_overlay",
		)!;
		expect(overlay.occurrences).toEqual([]);
	});

	it("fails when draft_revision_id belongs to another content row", async () => {
		const item = await insertPost(ctx, {
			slug: "live-post",
			status: "published",
			data: { title: "Live Title" },
		});
		const other = await insertPost(ctx, {
			slug: "other-post",
			status: "published",
			data: { title: "Other Title" },
		});
		const draft = await revisionRepo.create({
			collection: "posts",
			entryId: other.id,
			data: { title: "Other Draft" },
		});
		await setDraftRevision(ctx, item.id, draft.id);

		const result = await loadContentMediaUsageSnapshots(ctx.db, "posts", item.id);

		expect(result).toEqual(
			expect.objectContaining({
				success: false,
				error: "DRAFT_REVISION_MISMATCH",
				source: expect.objectContaining({ sourceVariant: "draft_overlay" }),
			}),
		);
	});

	it("fails when draft revision data is invalid JSON", async () => {
		const item = await insertPost(ctx, {
			slug: "live-post",
			status: "published",
			data: { title: "Live Title" },
		});
		const revisionId = ulid();
		await sql`
			INSERT INTO revisions (id, collection, entry_id, data, author_id)
			VALUES (${revisionId}, ${"posts"}, ${item.id}, ${"{"}, ${null})
		`.execute(ctx.db);
		await setDraftRevision(ctx, item.id, revisionId);

		const result = await loadContentMediaUsageSnapshots(ctx.db, "posts", item.id);

		expect(result).toEqual(
			expect.objectContaining({
				success: false,
				error: "DRAFT_REVISION_INVALID",
				source: expect.objectContaining({ sourceVariant: "draft_overlay" }),
			}),
		);
	});

	it("adds stable source schema versions and fingerprints to snapshots", async () => {
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

		const firstResult = await loadContentMediaUsageSnapshots(ctx.db, "posts", item.id);
		const secondResult = await loadContentMediaUsageSnapshots(ctx.db, "posts", item.id);

		expect(firstResult.success).toBe(true);
		expect(secondResult.success).toBe(true);
		if (!firstResult.success) throw new Error(firstResult.error);
		if (!secondResult.success) throw new Error(secondResult.error);
		const firstColumns = getSnapshot(firstResult, "columns");
		const firstOverlay = getSnapshot(firstResult, "draft_overlay");
		const secondColumns = getSnapshot(secondResult, "columns");
		const secondOverlay = getSnapshot(secondResult, "draft_overlay");

		expect(firstColumns.source.schemaVersion).toBe(1);
		expect(firstOverlay.source.schemaVersion).toBe(1);
		expect(firstColumns.source.sourceFingerprint).toEqual(expect.stringMatching(/^[a-f0-9]{16}$/));
		expect(firstOverlay.source.sourceFingerprint).toEqual(expect.stringMatching(/^[a-f0-9]{16}$/));
		expect(firstOverlay.source.sourceFingerprint).not.toBe(firstColumns.source.sourceFingerprint);
		expect(secondColumns.source.sourceFingerprint).toBe(firstColumns.source.sourceFingerprint);
		expect(secondOverlay.source.sourceFingerprint).toBe(firstOverlay.source.sourceFingerprint);
	});

	it("changes fingerprints when extraction-relevant values or fields change", async () => {
		const item = await insertPost(ctx, {
			slug: "live-post",
			status: "published",
			data: {
				title: "Live Title",
				hero: { id: "media-live", provider: "local", mimeType: "image/webp" },
			},
		});
		const initial = await loadContentMediaUsageSnapshots(ctx.db, "posts", item.id);
		expect(initial.success).toBe(true);
		if (!initial.success) throw new Error(initial.error);
		const initialFingerprint = getSnapshot(initial, "columns").source.sourceFingerprint;

		await updatePostHero(ctx, item.id, {
			id: "media-updated",
			provider: "local",
			mimeType: "image/webp",
		});
		const valueChanged = await loadContentMediaUsageSnapshots(ctx.db, "posts", item.id);
		expect(valueChanged.success).toBe(true);
		if (!valueChanged.success) throw new Error(valueChanged.error);
		const valueChangedFingerprint = getSnapshot(valueChanged, "columns").source.sourceFingerprint;

		await registry.createField("posts", {
			slug: "thumbnail",
			label: "Thumbnail",
			type: "image",
		});
		const fieldChanged = await loadContentMediaUsageSnapshots(ctx.db, "posts", item.id);
		expect(fieldChanged.success).toBe(true);
		if (!fieldChanged.success) throw new Error(fieldChanged.error);
		const fieldChangedFingerprint = getSnapshot(fieldChanged, "columns").source.sourceFingerprint;

		expect(valueChangedFingerprint).not.toBe(initialFingerprint);
		expect(fieldChangedFingerprint).not.toBe(valueChangedFingerprint);
	});

	it("keeps fingerprints stable for non-extraction schema metadata changes", async () => {
		const item = await insertPost(ctx, {
			slug: "live-post",
			status: "published",
			data: {
				title: "Live Title",
				hero: { id: "media-live", provider: "local", mimeType: "image/webp" },
				attachment: { id: "file-live", provider: "local", mimeType: "application/pdf" },
			},
		});
		const before = await loadContentMediaUsageSnapshots(ctx.db, "posts", item.id);
		expect(before.success).toBe(true);
		if (!before.success) throw new Error(before.error);
		const beforeFingerprint = getSnapshot(before, "columns").source.sourceFingerprint;

		await ctx.db
			.updateTable("_emdash_fields")
			.set({
				label: "Hero Image",
				required: 1,
				validation: JSON.stringify({ allowedMimeTypes: ["image/png"] }),
				sort_order: 999,
			})
			.where("slug", "=", "hero")
			.execute();
		await ctx.db
			.updateTable("_emdash_fields")
			.set({ sort_order: -999 })
			.where("slug", "=", "attachment")
			.execute();

		const after = await loadContentMediaUsageSnapshots(ctx.db, "posts", item.id);
		expect(after.success).toBe(true);
		if (!after.success) throw new Error(after.error);

		expect(getSnapshot(after, "columns").source.sourceFingerprint).toBe(beforeFingerprint);
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
	updatedAt: string;
	version: number;
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
			hero,
			attachment,
			sections,
			body,
			raw_data
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
			${serializeFieldValue(input.data.hero)},
			${serializeFieldValue(input.data.attachment)},
			${serializeFieldValue(input.data.sections)},
			${serializeFieldValue(input.data.body)},
			${serializeFieldValue(input.data.raw_data)}
		)
	`.execute(ctx.db);

	return {
		id,
		slug: input.slug,
		status: input.status,
		updatedAt: now,
		version: 1,
		translationGroup: id,
	};
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

function getSnapshot(
	result: Extract<Awaited<ReturnType<typeof loadContentMediaUsageSnapshots>>, { success: true }>,
	sourceVariant: "columns" | "draft_overlay",
) {
	const snapshot = result.snapshots.find(
		(candidate) => candidate.source.sourceVariant === sourceVariant,
	);
	if (!snapshot) throw new Error(`Missing ${sourceVariant} snapshot`);
	return snapshot;
}

function serializeFieldValue(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === "object") return JSON.stringify(value);
	return value;
}
