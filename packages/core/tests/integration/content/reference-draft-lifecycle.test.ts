/**
 * A reference selection follows the entry's draft: staged on save, promoted on
 * publish, dropped with a discarded draft, and restored with an older revision —
 * the same lifecycle any other field value has.
 */

import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	handleContentCompare,
	handleContentCreate,
	handleContentDiscardDraft,
	handleContentDuplicate,
	handleContentGet,
	handleContentPublish,
} from "../../../src/api/handlers/content.js";
import { handleRevisionRestore } from "../../../src/api/handlers/revision.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { REFERENCE_PAGE_LIMIT } from "../../../src/references/staged.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	asInlineTransaction,
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("versioned reference selections", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);

		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "pages", label: "Pages", labelSingular: "Page" });
		await registry.createField("pages", { slug: "title", label: "Title", type: "string" });
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

		const relations = new RelationRepository(ctx.db);
		await relations.create({
			slug: "posts_related_pages",
			parentCollection: "posts",
			childCollection: "pages",
			parentLabel: "Posts",
			childLabel: "Related pages",
		});
		await registry.createField("posts", {
			slug: "related_pages",
			label: "Related pages",
			type: "reference",
			validation: {
				relation: "posts_related_pages",
				relationSide: "parent",
				targetCollection: "pages",
			},
		});

		runtime = createTestRuntime(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	/** Published, so a read that excludes drafts still resolves the selection. */
	async function createPage(title: string) {
		const result = await handleContentCreate(ctx.db, "pages", {
			data: { title },
			slug: title.toLowerCase().replaceAll(" ", "-"),
		});
		if (!result.success) throw new Error(`Page setup failed: ${result.error.message}`);
		const published = await runtime.handleContentPublish("pages", result.data.item.id);
		if (!published.success) throw new Error("Page publish failed");
		return result.data.item;
	}

	/** The live selection, as translation groups in link order. */
	async function liveGroups(postId: string): Promise<string[]> {
		const post = await new ContentRepository(ctx.db).findById("posts", postId);
		if (!post?.translationGroup) throw new Error("Post has no translation group");
		const page = await new RelationRepository(ctx.db).getChildrenPage(
			"posts_related_pages",
			post.translationGroup,
		);
		return page.items.map((edge) => edge.childGroup);
	}

	/** The selection staged in the entry's draft revision, if it has one. */
	async function stagedGroups(postId: string): Promise<unknown> {
		const post = await new ContentRepository(ctx.db).findById("posts", postId);
		if (!post?.draftRevisionId) return undefined;
		const revision = await new RevisionRepository(ctx.db).findById(post.draftRevisionId);
		const staged = revision?.data._references;
		if (typeof staged !== "object" || staged === null) return undefined;
		return Reflect.get(staged, "related_pages");
	}

	async function publishedPost(title: string, pageIds: string[]) {
		const created = await runtime.handleContentCreate("posts", {
			data: { title },
			slug: title.toLowerCase().replaceAll(" ", "-"),
			references: { related_pages: pageIds },
		});
		if (!created.success || !created.data) throw new Error("Post setup failed");
		const id = created.data.item.id;
		const published = await runtime.handleContentPublish("posts", id);
		if (!published.success) throw new Error("Post publish failed");
		return id;
	}

	it("stages a picker change instead of writing links, then promotes it on publish", async () => {
		const [a, b] = [await createPage("A"), await createPage("B")];
		const id = await publishedPost("Staged", [a.id]);

		const saved = await runtime.handleContentUpdate("posts", id, {
			references: { related_pages: [b.id] },
		});
		expect(saved.success).toBe(true);

		expect(await liveGroups(id)).toEqual([a.translationGroup]);
		expect(await stagedGroups(id)).toEqual([b.translationGroup]);

		const published = await runtime.handleContentPublish("posts", id);
		expect(published.success).toBe(true);
		expect(await liveGroups(id)).toEqual([b.translationGroup]);
	});

	it("leaves the draft staging the selection when the promotion cannot complete", async () => {
		const [a, b] = [await createPage("A"), await createPage("B")];
		const id = await publishedPost("Interrupted", [a.id]);
		await runtime.handleContentUpdate("posts", id, { references: { related_pages: [b.id] } });

		// With the link table gone the promotion cannot run. The handler executes
		// inline — D1's boundary, where a statement that has run stays run — so
		// what survives the failure here is what a D1 publish would leave behind.
		await sql`DROP TABLE ${sql.ref("_emdash_content_references")}`.execute(ctx.db);

		const inline = asInlineTransaction(ctx.db);
		const published = await handleContentPublish(inline, "posts", id);
		expect(published.success).toBe(false);

		// The draft pointer is the only thing that can find the staged selection
		// again, so a failed promotion must not have spent it.
		const post = await new ContentRepository(ctx.db).findById("posts", id);
		expect(post?.draftRevisionId).toBeTruthy();
	});

	it("leaves the live selection alone when the publish itself is refused", async () => {
		const [a, b] = [await createPage("A"), await createPage("B")];
		const id = await publishedPost("Refused", [a.id]);
		await runtime.handleContentUpdate("posts", id, { references: { related_pages: [b.id] } });

		// The entry is not scheduled, so this publish is refused outright. Run
		// inline — D1's boundary — so a promotion that ran before the refusal
		// would still be standing afterwards.
		const inline = asInlineTransaction(ctx.db);
		const published = await handleContentPublish(inline, "posts", id, {
			requireScheduledDue: true,
			expectedScheduledAt: "2099-01-01T00:00:00.000Z",
		});
		expect(published.success).toBe(false);

		// Nothing was published, so nothing of the draft may be live: a promoted
		// selection on an unpublished entry shows readers a choice never published.
		expect(await liveGroups(id)).toEqual([a.translationGroup]);
		expect(await stagedGroups(id)).toEqual([b.translationGroup]);
	});

	it("pages a staged selection the way it pages a live one", async () => {
		const pages: string[] = [];
		for (let index = 0; index < REFERENCE_PAGE_LIMIT + 1; index++) {
			// Drafts are enough: the read that follows may see them, and publishing
			// each one would only slow the setup down.
			const created = await handleContentCreate(ctx.db, "pages", {
				data: { title: `Page ${index}` },
				slug: `page-${index}`,
			});
			if (!created.success) throw new Error("Page setup failed");
			pages.push(created.data.item.id);
		}

		const id = await publishedPost("Paged", []);
		const saved = await runtime.handleContentUpdate("posts", id, {
			references: { related_pages: pages },
		});
		expect(saved.success).toBe(true);

		const got = await handleContentGet(ctx.db, "posts", id, undefined, { includeDrafts: true });
		expect(got.success).toBe(true);
		if (!got.success) return;

		const field = got.data.item.references?.related_pages;
		expect(field?.children).toHaveLength(REFERENCE_PAGE_LIMIT);
		expect(field?.nextCursor).toBeTruthy();
	});

	it("reports a staged selection to a drafts-aware read and the live one otherwise", async () => {
		const [a, b] = [await createPage("A"), await createPage("B")];
		const id = await publishedPost("Overlay", [a.id]);

		await runtime.handleContentUpdate("posts", id, { references: { related_pages: [b.id] } });

		const withDrafts = await runtime.handleContentGet("posts", id, undefined, {
			includeDrafts: true,
		});
		expect(withDrafts.success).toBe(true);
		expect(withDrafts.data?.item.references?.related_pages?.children.map((c) => c.id)).toEqual([
			b.id,
		]);

		const withoutDrafts = await runtime.handleContentGet("posts", id, undefined, {
			includeDrafts: false,
		});
		expect(withoutDrafts.data?.item.references?.related_pages?.children.map((c) => c.id)).toEqual([
			a.id,
		]);
	});

	it("does not touch a picker-only save's live row", async () => {
		const [a, b] = [await createPage("A"), await createPage("B")];
		const id = await publishedPost("Untouched", [a.id]);
		const before = await new ContentRepository(ctx.db).findById("posts", id);

		const saved = await runtime.handleContentUpdate("posts", id, {
			references: { related_pages: [b.id] },
		});

		expect(saved.success && saved.liveContentChanged).toBe(false);
		const after = await new ContentRepository(ctx.db).findById("posts", id);
		expect(after?.status).toBe(before?.status);
		expect(after?.liveRevisionId).toBe(before?.liveRevisionId);
	});

	it("keeps a field the save did not name staged alongside the one it did", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await new RelationRepository(ctx.db).create({
			slug: "posts_featured_page",
			parentCollection: "posts",
			childCollection: "pages",
			parentLabel: "Posts",
			childLabel: "Featured page",
		});
		await registry.createField("posts", {
			slug: "featured_page",
			label: "Featured page",
			type: "reference",
			validation: {
				relation: "posts_featured_page",
				relationSide: "parent",
				targetCollection: "pages",
			},
		});

		const [a, b] = [await createPage("A"), await createPage("B")];
		const id = await publishedPost("Two fields", []);

		await runtime.handleContentUpdate("posts", id, { references: { featured_page: [a.id] } });
		await runtime.handleContentUpdate("posts", id, { references: { related_pages: [b.id] } });

		const post = await new ContentRepository(ctx.db).findById("posts", id);
		const revision = await new RevisionRepository(ctx.db).findById(post!.draftRevisionId!);
		expect(revision?.data._references).toEqual({
			featured_page: [a.translationGroup],
			related_pages: [b.translationGroup],
		});
	});

	it("compares a staged selection against the published one, filling both from the links", async () => {
		const [a, b] = [await createPage("A"), await createPage("B")];
		const id = await publishedPost("Compared", [a.id]);

		const published = await handleContentCompare(ctx.db, "posts", id);
		expect(published.success).toBe(true);
		if (!published.success) return;
		expect(published.data.live?._references).toEqual({ related_pages: [a.translationGroup] });

		// A draft that changed only the title stages no selection, so its side has
		// to show the published one rather than read as a field it removed.
		await runtime.handleContentUpdate("posts", id, { data: { title: "Retitled" } });
		const titleOnly = await handleContentCompare(ctx.db, "posts", id);
		expect(titleOnly.success).toBe(true);
		if (!titleOnly.success) return;
		expect(titleOnly.data.draft?._references).toEqual({ related_pages: [a.translationGroup] });

		await runtime.handleContentUpdate("posts", id, { references: { related_pages: [b.id] } });

		const changed = await handleContentCompare(ctx.db, "posts", id);
		expect(changed.success).toBe(true);
		if (!changed.success) return;
		expect(changed.data.live?._references).toEqual({ related_pages: [a.translationGroup] });
		expect(changed.data.draft?._references).toEqual({ related_pages: [b.translationGroup] });
	});

	it("drops a staged selection with the discarded draft, leaving links alone", async () => {
		const [a, b] = [await createPage("A"), await createPage("B")];
		const id = await publishedPost("Discarded", [a.id]);

		await runtime.handleContentUpdate("posts", id, { references: { related_pages: [b.id] } });
		const discarded = await handleContentDiscardDraft(ctx.db, "posts", id);
		expect(discarded.success).toBe(true);

		expect(await liveGroups(id)).toEqual([a.translationGroup]);
		expect(await stagedGroups(id)).toBeUndefined();
	});

	it("publishes the latest of two autosaves from a single draft revision", async () => {
		const [a, b, c] = [await createPage("A"), await createPage("B"), await createPage("C")];
		const id = await publishedPost("Autosaved", [a.id]);

		await runtime.handleContentUpdate("posts", id, {
			references: { related_pages: [b.id] },
			skipRevision: true,
		});
		await runtime.handleContentUpdate("posts", id, {
			references: { related_pages: [c.id] },
			skipRevision: true,
		});

		expect(await stagedGroups(id)).toEqual([c.translationGroup]);

		await runtime.handleContentPublish("posts", id);
		expect(await liveGroups(id)).toEqual([c.translationGroup]);
	});

	it("restores an older revision's selection as live links", async () => {
		const [a, b] = [await createPage("A"), await createPage("B")];
		const id = await publishedPost("Restored", [a.id]);

		await runtime.handleContentUpdate("posts", id, { references: { related_pages: [a.id] } });
		const olderRevisionId = (await new ContentRepository(ctx.db).findById("posts", id))!
			.draftRevisionId!;
		await runtime.handleContentPublish("posts", id);

		await runtime.handleContentUpdate("posts", id, { references: { related_pages: [b.id] } });
		await runtime.handleContentPublish("posts", id);
		expect(await liveGroups(id)).toEqual([b.translationGroup]);

		const restored = await handleRevisionRestore(ctx.db, olderRevisionId, "user-1");
		expect(restored.success).toBe(true);
		expect(await liveGroups(id)).toEqual([a.translationGroup]);
	});

	it("restores the selection an entry was first published with", async () => {
		const [a, b] = [await createPage("A"), await createPage("B")];
		const id = await publishedPost("Original", [a.id]);
		const initialRevisionId = (await new ContentRepository(ctx.db).findById("posts", id))!
			.liveRevisionId!;

		await runtime.handleContentUpdate("posts", id, {
			data: { title: "Edited" },
			references: { related_pages: [b.id, a.id] },
		});
		await runtime.handleContentPublish("posts", id);
		expect(await liveGroups(id)).toEqual([b.translationGroup, a.translationGroup]);

		const restored = await runtime.handleRevisionRestore(initialRevisionId, "user-1");
		expect(restored.success).toBe(true);
		expect(await stagedGroups(id)).toEqual([a.translationGroup]);

		const published = await runtime.handleContentPublish("posts", id);
		expect(published.success).toBe(true);
		if (published.success) expect(published.data.item.data.title).toBe("Original");
		expect(await liveGroups(id)).toEqual([a.translationGroup]);
	});

	it("restores the selection a revision published without naming", async () => {
		const [a, b] = [await createPage("A"), await createPage("B")];
		const id = await publishedPost("Untouched", [a.id]);

		await runtime.handleContentUpdate("posts", id, { data: { title: "Retitled" } });
		await runtime.handleContentPublish("posts", id);
		const retitledRevisionId = (await new ContentRepository(ctx.db).findById("posts", id))!
			.liveRevisionId!;

		await runtime.handleContentUpdate("posts", id, { references: { related_pages: [b.id] } });
		await runtime.handleContentPublish("posts", id);
		expect(await liveGroups(id)).toEqual([b.translationGroup]);

		await runtime.handleRevisionRestore(retitledRevisionId, "user-1");
		await runtime.handleContentPublish("posts", id);
		expect(await liveGroups(id)).toEqual([a.translationGroup]);
	});

	it("refuses to restore a selection the relation has since outgrown", async () => {
		const [a, b] = [await createPage("A"), await createPage("B")];
		const id = await publishedPost("Outgrown", [a.id]);

		await runtime.handleContentUpdate("posts", id, {
			references: { related_pages: [a.id, b.id] },
		});
		const revisionId = (await new ContentRepository(ctx.db).findById("posts", id))!
			.draftRevisionId!;
		await runtime.handleContentPublish("posts", id);
		expect(await liveGroups(id)).toEqual([a.translationGroup, b.translationGroup]);

		const relations = new RelationRepository(ctx.db);
		await relations.update((await relations.findBySlug("posts_related_pages"))!.id, {
			maxChildrenPerParent: 1,
		});
		await runtime.handleContentUpdate("posts", id, { references: { related_pages: [a.id] } });
		await runtime.handleContentPublish("posts", id);

		// Restoring would put the two-page selection back under a relation that now
		// allows one, so it is refused rather than written past the limit.
		const restored = await handleRevisionRestore(ctx.db, revisionId, "user-1");
		expect(restored.success).toBe(false);
		if (!restored.success) expect(restored.error.code).toBe("VALIDATION_ERROR");
		expect(await liveGroups(id)).toEqual([a.translationGroup]);
	});

	it("copies live links to a duplicate, not the source's staged selection", async () => {
		const [a, b] = [await createPage("A"), await createPage("B")];
		const id = await publishedPost("Duplicated", [a.id]);
		await runtime.handleContentUpdate("posts", id, { references: { related_pages: [b.id] } });

		const copy = await handleContentDuplicate(ctx.db, "posts", id);
		expect(copy.success).toBe(true);
		if (!copy.success) return;

		const relations = new RelationRepository(ctx.db);
		const copyItem = await new ContentRepository(ctx.db).findById("posts", copy.data.item.id);
		const links = await relations.getChildrenPage(
			"posts_related_pages",
			copyItem!.translationGroup!,
		);
		expect(links.items.map((edge) => edge.childGroup)).toEqual([a.translationGroup]);
	});

	it("refuses to publish a staged selection the relation has since outgrown", async () => {
		const [a, b] = [await createPage("A"), await createPage("B")];
		const relations = new RelationRepository(ctx.db);
		const relation = await relations.findBySlug("posts_related_pages");

		const id = await publishedPost("Tightened", [a.id]);
		await runtime.handleContentUpdate("posts", id, {
			references: { related_pages: [a.id, b.id] },
		});

		await relations.update(relation!.id, { maxChildrenPerParent: 1 });

		const published = await runtime.handleContentPublish("posts", id);
		expect(published.success).toBe(false);
		if (!published.success) {
			expect(published.error.code).toBe("VALIDATION_ERROR");
			expect(published.error.message).toContain("related_pages");
		}
		expect(await liveGroups(id)).toEqual([a.translationGroup]);
	});

	it("refuses to publish a staged selection another entry has since claimed", async () => {
		const a = await createPage("A");
		const relations = new RelationRepository(ctx.db);
		const relation = await relations.findBySlug("posts_related_pages");
		await relations.update(relation!.id, { maxParentsPerChild: 1 });

		// Staged while the page was free to take.
		const id = await publishedPost("First", []);
		await runtime.handleContentUpdate("posts", id, { references: { related_pages: [a.id] } });

		// Another post takes the page's only parent slot before this draft publishes.
		await publishedPost("Second", [a.id]);

		const published = await runtime.handleContentPublish("posts", id);
		expect(published.success).toBe(false);
		if (!published.success) expect(published.error.code).toBe("VALIDATION_ERROR");
		expect(await liveGroups(id)).toEqual([]);
	});

	it("rejects a save that empties a required reference field outright", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await new RelationRepository(ctx.db).create({
			slug: "posts_hero_page",
			parentCollection: "posts",
			childCollection: "pages",
			parentLabel: "Posts",
			childLabel: "Hero page",
		});
		await registry.createField("posts", {
			slug: "hero_page",
			label: "Hero page",
			type: "reference",
			required: true,
			validation: {
				relation: "posts_hero_page",
				relationSide: "parent",
				targetCollection: "pages",
			},
		});

		const a = await createPage("A");
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Required" },
			slug: "required-now",
			references: { related_pages: [], hero_page: [a.id] },
		});
		expect(created.success).toBe(true);
		const id = created.data!.item.id;

		const saved = await runtime.handleContentUpdate("posts", id, {
			references: { hero_page: [] },
		});
		expect(saved.success).toBe(false);
		if (!saved.success) {
			expect(saved.error.code).toBe("VALIDATION_ERROR");
			expect(saved.error.message).toContain("hero_page");
		}
	});

	it("refuses to publish a draft that does not satisfy a required field added later", async () => {
		const id = await publishedPost("Predates the field", []);

		// A required reference field added to a collection that already holds
		// entries: nothing they have staged mentions it.
		const registry = new SchemaRegistry(ctx.db);
		await new RelationRepository(ctx.db).create({
			slug: "posts_hero_page",
			parentCollection: "posts",
			childCollection: "pages",
			parentLabel: "Posts",
			childLabel: "Hero page",
			maxChildrenPerParent: 1,
		});
		await registry.createField("posts", {
			slug: "hero_page",
			label: "Hero page",
			type: "reference",
			required: true,
			validation: {
				relation: "posts_hero_page",
				relationSide: "parent",
				targetCollection: "pages",
			},
		});

		const saved = await runtime.handleContentUpdate("posts", id, { data: { title: "Renamed" } });
		expect(saved.success).toBe(true);

		const published = await runtime.handleContentPublish("posts", id);

		expect(published.success).toBe(false);
		if (!published.success) expect(published.error.code).toBe("VALIDATION_ERROR");
	});

	it("carries a child-side field's selection onto a duplicate", async () => {
		// `pages` views the same relation from the child end, so the page's own
		// field selection is the set of posts pointing at it.
		await new SchemaRegistry(ctx.db).createField("pages", {
			slug: "linking_posts",
			label: "Linking posts",
			type: "reference",
			validation: {
				relation: "posts_related_pages",
				relationSide: "child",
				targetCollection: "posts",
			},
		});
		const page = await createPage("Linked");
		await publishedPost("Links to it", [page.id]);

		const copy = await handleContentDuplicate(ctx.db, "pages", page.id);
		expect(copy.success).toBe(true);
		if (!copy.success) return;

		const copyItem = await new ContentRepository(ctx.db).findById("pages", copy.data.item.id);
		const parents = await new RelationRepository(ctx.db).getParentsPage(
			"posts_related_pages",
			copyItem!.translationGroup!,
		);
		expect(parents.items).toHaveLength(1);
	});
});
