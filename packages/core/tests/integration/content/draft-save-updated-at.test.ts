/**
 * Draft saves on published entries must not advance the content row's
 * `updated_at` (#2143).
 *
 * On revision-supporting collections, **Save** and **Autosave** on an
 * already-published entry store changes as a pending draft — live public
 * content is unchanged until **Publish**. Those draft-only writes previously
 * bumped `updated_at` anyway, which public SEO surfaces (sitemap <lastmod>,
 * JSON-LD dateModified) treat as "content last modified" — a phantom
 * modification for crawlers.
 *
 * The fix skips the `updated_at` stamp on content-row writes that touch no
 * live columns (pure draft staging / discard), and restores the pre-save
 * timestamp when a draft-only update request resolves to a metadata no-op.
 */

import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { Database } from "../../../src/database/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("draft saves on published entries keep updated_at (#2143)", () => {
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		// Default supports: drafts + revisions.
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		// No revision support: updates land directly on the live row.
		await registry.createCollection({
			slug: "plain_posts",
			label: "Plain Posts",
			supports: [],
		});
		await registry.createField("plain_posts", {
			slug: "title",
			label: "Title",
			type: "string",
		});
		runtime = createTestRuntime(db);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	it("Save (draft staging) on a published entry does not bump updated_at", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Live Post" },
			slug: "live-post",
		});
		expect(created.success).toBe(true);
		const id = created.data!.item.id;

		const published = await runtime.handleContentPublish("posts", id);
		expect(published.success).toBe(true);
		const publishedUpdatedAt = published.data!.item.updatedAt;

		// Manual Save: no skipRevision → creates a new draft revision and
		// points draft_revision_id at it. Live columns are untouched.
		const saved = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Live Post (edited, unpublished)" },
		});
		expect(saved.success).toBe(true);
		expect(saved.data!.item.draftRevisionId).not.toBeNull();

		expect(saved.data!.item.updatedAt).toBe(publishedUpdatedAt);
	});

	it("Autosave (skipRevision) on an existing draft does not bump updated_at", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Live Post" },
			slug: "live-post",
		});
		const id = created.data!.item.id;
		const published = await runtime.handleContentPublish("posts", id);
		const publishedUpdatedAt = published.data!.item.updatedAt;

		const firstSave = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Draft v1" },
		});
		expect(firstSave.success).toBe(true);
		expect(firstSave.data!.item.updatedAt).toBe(publishedUpdatedAt);

		// Autosave replaces the previous draft without changing the live row.
		const autosaved = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Draft v2" },
			skipRevision: true,
		});
		expect(autosaved.success).toBe(true);
		expect(autosaved.data!.item.updatedAt).toBe(publishedUpdatedAt);
	});

	it("Autosave removes the superseded draft after the pointer swap", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Live Post" },
			slug: "autosave-cleanup",
		});
		const id = created.data!.item.id;
		await runtime.handleContentPublish("posts", id);
		const firstSave = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Draft v1" },
		});
		const firstDraftId = firstSave.data!.item.draftRevisionId!;
		const revisionRepo = new RevisionRepository(db);

		const autosaved = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Draft v2" },
			skipRevision: true,
		});

		expect(autosaved.success).toBe(true);
		expect(autosaved.data!.item.draftRevisionId).not.toBe(firstDraftId);
		expect(await revisionRepo.findById(firstDraftId)).toBeNull();
	});

	it("Autosave never mutates a revision that is also live", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Live Post" },
			slug: "immutable-live",
		});
		const id = created.data!.item.id;
		const published = await runtime.handleContentPublish("posts", id);
		const liveRevisionId = published.data!.item.liveRevisionId!;
		const repo = new ContentRepository(db);
		const revisionRepo = new RevisionRepository(db);
		await repo.setDraftRevision("posts", id, liveRevisionId);

		const autosaved = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Draft edit" },
			skipRevision: true,
		});

		expect(autosaved.success).toBe(true);
		expect(autosaved.data!.item.draftRevisionId).not.toBe(liveRevisionId);
		expect((await revisionRepo.findById(liveRevisionId))?.data.title).toBe("Live Post");
	});

	it("returns CONFLICT and removes the new revision when the draft pointer CAS loses", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Initial" },
			slug: "draft-race",
		});
		const id = created.data!.item.id;
		const revisionRepo = new RevisionRepository(db);
		const beforeCount = await revisionRepo.countByEntry("posts", id);
		const originalCreate = RevisionRepository.prototype.create;
		const create = vi
			.spyOn(RevisionRepository.prototype, "create")
			.mockImplementationOnce(async function (input) {
				const revision = await originalCreate.call(this, input);
				await sql`UPDATE ec_posts SET version = version + 1 WHERE id = ${id}`.execute(db);
				return revision;
			});

		const result = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Losing draft" },
			_rev: Buffer.from(`${created.data!.item.version}:${created.data!.item.updatedAt}`).toString(
				"base64",
			),
		});
		create.mockRestore();

		expect(result).toMatchObject({ success: false, error: { code: "CONFLICT" } });
		expect(await revisionRepo.countByEntry("posts", id)).toBe(beforeCount);
		expect((await new ContentRepository(db).findById("posts", id))?.draftRevisionId).toBeNull();
	});

	it("rebases a blind save after a draft pointer CAS loss without leaving an orphan", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Initial" },
			slug: "draft-retry",
		});
		const id = created.data!.item.id;
		const revisionRepo = new RevisionRepository(db);
		const originalCreate = RevisionRepository.prototype.create;
		vi.spyOn(RevisionRepository.prototype, "create").mockImplementationOnce(async function (input) {
			const revision = await originalCreate.call(this, input);
			await sql`UPDATE ec_posts SET version = version + 1 WHERE id = ${id}`.execute(db);
			return revision;
		});

		const result = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Retried draft" },
		});

		expect(result.success).toBe(true);
		expect(result.data!.item.data.title).toBe("Retried draft");
		expect(await revisionRepo.countByEntry("posts", id)).toBe(1);
	});

	it("Discard Draft restores updated_at from before the draft saves", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Live Post" },
			slug: "live-post",
		});
		const id = created.data!.item.id;
		const published = await runtime.handleContentPublish("posts", id);
		const publishedUpdatedAt = published.data!.item.updatedAt;

		const saved = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Unwanted edit" },
		});
		expect(saved.success).toBe(true);

		const discarded = await runtime.handleContentDiscardDraft("posts", id);
		expect(discarded.success).toBe(true);
		expect(discarded.data!.item.draftRevisionId).toBeNull();
		expect(discarded.data!.item.updatedAt).toBe(publishedUpdatedAt);
	});

	it("a subsequent Publish advances updated_at exactly once", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Live Post" },
			slug: "live-post",
		});
		const id = created.data!.item.id;
		const published = await runtime.handleContentPublish("posts", id);
		const publishedUpdatedAt = published.data!.item.updatedAt;

		const saved = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Ready to go live" },
		});
		expect(saved.data!.item.updatedAt).toBe(publishedUpdatedAt);

		// The draft saves left updated_at untouched, so comparing with Date.now()
		// proves publish moves it forward (same-millisecond collisions impossible).
		const republished = await runtime.handleContentPublish("posts", id);
		expect(republished.success).toBe(true);
		expect(republished.data!.item.draftRevisionId).toBeNull();
		expect(Date.parse(republished.data!.item.updatedAt)).toBeGreaterThan(
			Date.parse(publishedUpdatedAt),
		);
	});

	it("draft-only saves still bump version so _rev concurrency detection keeps working", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Live Post" },
			slug: "live-post",
		});
		const id = created.data!.item.id;
		const published = await runtime.handleContentPublish("posts", id);
		const publishedUpdatedAt = published.data!.item.updatedAt;
		const publishedVersion = published.data!.item.version;

		const saved = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Edited" },
		});
		expect(saved.success).toBe(true);
		// updated_at frozen (no phantom modification), but version moved so a
		// second editor holding the pre-save _rev gets a 409.
		expect(saved.data!.item.updatedAt).toBe(publishedUpdatedAt);
		expect(saved.data!.item.version).toBe(publishedVersion + 1);

		const stale = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Conflicting edit" },
			_rev: Buffer.from(`${publishedVersion}:${publishedUpdatedAt}`).toString("base64"),
		});
		expect(stale.success).toBe(false);
		expect(stale.success === false && stale.error.code).toBe("CONFLICT");
	});

	it("Restore Revision (to draft) on a published entry does not bump updated_at", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Original" },
			slug: "restore-post",
		});
		const id = created.data!.item.id;
		const published = await runtime.handleContentPublish("posts", id);
		const publishedUpdatedAt = published.data!.item.updatedAt;

		// Find the published revision to restore from.
		const revisions = await runtime.handleRevisionList("posts", id);
		expect(revisions.success).toBe(true);
		const liveRevisionId = published.data!.item.liveRevisionId;
		const targetRevision = revisions.data!.items.find((r) => r.id === liveRevisionId);
		expect(targetRevision).toBeDefined();

		// Restore that revision as the current draft — draft-only staging,
		// live columns untouched, so updated_at must not move.
		const restored = await runtime.handleRevisionRestore(targetRevision!.id, "author-1");
		expect(restored.success).toBe(true);
		expect(restored.data!.item.updatedAt).toBe(publishedUpdatedAt);
		expect(restored.data!.item.draftRevisionId).not.toBeNull();
	});

	it("Restore returns CONFLICT and removes its new revision when the pointer CAS loses", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Original" },
			slug: "restore-race",
		});
		const id = created.data!.item.id;
		const published = await runtime.handleContentPublish("posts", id);
		const targetRevisionId = published.data!.item.liveRevisionId!;
		const revisionRepo = new RevisionRepository(db);
		const beforeCount = await revisionRepo.countByEntry("posts", id);
		const originalCreate = RevisionRepository.prototype.create;
		vi.spyOn(RevisionRepository.prototype, "create").mockImplementationOnce(async function (input) {
			const revision = await originalCreate.call(this, input);
			await sql`UPDATE ec_posts SET version = version + 1 WHERE id = ${id}`.execute(db);
			return revision;
		});

		const restored = await runtime.handleRevisionRestore(targetRevisionId, "author-1");

		expect(restored).toMatchObject({ success: false, error: { code: "CONFLICT" } });
		expect(await revisionRepo.countByEntry("posts", id)).toBe(beforeCount);
		expect((await new ContentRepository(db).findById("posts", id))?.draftRevisionId).toBeNull();
	});

	it("collections without revision support keep the bump-on-write behavior", async () => {
		const created = await runtime.handleContentCreate("plain_posts", {
			data: { title: "Plain" },
			slug: "plain",
		});
		const id = created.data!.item.id;
		const beforeUpdate = created.data!.item.updatedAt;

		const updated = await runtime.handleContentUpdate("plain_posts", id, {
			data: { title: "Plain (edited)" },
		});
		expect(updated.success).toBe(true);
		expect(Date.parse(updated.data!.item.updatedAt)).toBeGreaterThanOrEqual(
			Date.parse(beforeUpdate),
		);
	});
});
