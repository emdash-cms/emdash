import { sql } from "kysely";
import { afterEach, expect, it } from "vitest";

import {
	handleContentCreate,
	handleContentDelete,
	handleContentDuplicate,
	handleContentGet,
	handleContentPermanentDelete,
	handleContentUpdate,
} from "../../../src/api/handlers/content.js";
import { setReferenceSelection } from "../../../src/api/handlers/relations.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createLegacyReferenceField } from "../../utils/legacy-reference-field.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	asInlineTransaction,
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
} from "../../utils/test-db.js";
import type { DialectTestContext } from "../../utils/test-db.js";

describeEachDialect("content write refuses storage-less data keys", (dialect) => {
	let ctx: DialectTestContext;

	async function setupPosts(): Promise<void> {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", {
			slug: "related",
			label: "Related",
			type: "reference",
			validation: { relation: "grp_x", targetCollection: "posts", multiple: true },
		});
	}

	it("rejects a reference key placed in data on create, naming the key that takes it", async () => {
		ctx = await setupForDialect(dialect);
		try {
			await setupPosts();

			const res = await handleContentCreate(ctx.db, "posts", {
				data: { title: "A", related: ["some-entry-id"] },
			});

			expect(res).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
			if (!res.success) {
				expect(res.error.message).toContain("related");
				expect(res.error.message).toContain("references");
			}
			// Nothing was written: the rejection precedes the row.
			expect(await new ContentRepository(ctx.db).findMany("posts")).toMatchObject({ items: [] });
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("rejects a reference key placed in data on update", async () => {
		ctx = await setupForDialect(dialect);
		try {
			await setupPosts();
			const created = await handleContentCreate(ctx.db, "posts", { data: { title: "A" } });
			if (!created.success) throw new Error(created.error.message);

			const res = await handleContentUpdate(ctx.db, "posts", created.data.item.id, {
				data: { title: "B", related: ["some-entry-id"] },
			});

			expect(res).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
			const after = await handleContentGet(ctx.db, "posts", created.data.item.id);
			if (!after.success) throw new Error(after.error.message);
			expect(after.data.item.data).toMatchObject({ title: "A" });
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("still writes an unbound reference field's value to its own column", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
			// No `validation.relation`: the field keeps its TEXT column and behaves
			// like a string, so `data` is exactly where its value belongs.
			await registry.createField("posts", {
				slug: "author",
				label: "Author",
				type: "reference",
				validation: { targetCollection: "posts" },
			});

			const res = await handleContentCreate(ctx.db, "posts", {
				data: { title: "A", author: "post_abc" },
			});

			expect(res.success).toBe(true);
			if (res.success) expect(res.data.item.data).toMatchObject({ author: "post_abc" });
		} finally {
			await teardownForDialect(ctx);
		}
	});
});

describeEachDialect("a reference key in data on a collection that keeps drafts", (dialect) => {
	let ctx: DialectTestContext;

	it("is refused rather than staged into the draft revision", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
			await new RelationRepository(ctx.db).create({
				slug: "posts_related",
				parentCollection: "posts",
				childCollection: "posts",
				parentLabel: "Post",
				childLabel: "Related post",
			});
			await registry.createField("posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: {
					relation: "posts_related",
					relationSide: "parent",
					targetCollection: "posts",
				},
			});

			const runtime = createTestRuntime(ctx.db);
			const created = await runtime.handleContentCreate("posts", { data: { title: "A" } });
			if (!created.success) throw new Error(created.error.message);

			// A draft save never reaches the column writer, so nothing downstream
			// would notice the key. It has to be refused on the way in.
			const res = await runtime.handleContentUpdate("posts", created.data.item.id, {
				data: { title: "B", related: [created.data.item.id] },
			});

			expect(res).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
		} finally {
			await teardownForDialect(ctx);
		}
	});
});

describeEachDialect("saving an entry whose reference field was bound later", (dialect) => {
	let ctx: DialectTestContext;

	it("accepts the entry's own data back unchanged", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
			// The shape migration 084 leaves behind: the field is bound to a
			// relation and the column it filled before relations existed still holds
			// the value it last wrote, so every read hands that key back in `data`.
			await createLegacyReferenceField(ctx.db, "posts", "author", { targetCollection: "posts" });
			const created = await handleContentCreate(ctx.db, "posts", {
				data: { title: "A", author: "post_abc" },
			});
			if (!created.success) throw new Error(created.error.message);

			await new RelationRepository(ctx.db).create({
				slug: "posts_author",
				parentCollection: "posts",
				childCollection: "posts",
				parentLabel: "Author",
				childLabel: "Posts",
			});
			await ctx.db
				.updateTable("_emdash_fields")
				.set({
					validation: JSON.stringify({
						relation: "posts_author",
						relationSide: "parent",
						targetCollection: "posts",
					}),
				})
				.where("slug", "=", "author")
				.execute();

			const read = await handleContentGet(ctx.db, "posts", created.data.item.id);
			if (!read.success) throw new Error(read.error.message);
			expect(read.data.item.data).toMatchObject({ author: "post_abc" });

			// A read-then-write client — the admin editor among them — echoes the
			// key it was handed. That is not an attempt to set a selection.
			const res = await handleContentUpdate(ctx.db, "posts", created.data.item.id, {
				data: { ...read.data.item.data, title: "B" },
			});

			expect(res).toMatchObject({ success: true });
		} finally {
			await teardownForDialect(ctx);
		}
	});
});

describeEachDialect("translating an entry whose reference field was bound later", (dialect) => {
	let ctx: DialectTestContext;

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(ctx);
	});

	it("does not carry the frozen column value into the translation's data", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		// The shape migration 084 leaves behind: the field is bound to a relation,
		// and the column it filled before relations existed is still there holding
		// the value it last wrote. A non-translatable field is copied from the
		// source entry when a translation is created.
		await createLegacyReferenceField(ctx.db, "posts", "author", { targetCollection: "posts" });
		await ctx.db
			.updateTable("_emdash_fields")
			.set({ translatable: 0 })
			.where("slug", "=", "author")
			.execute();

		const runtime = createTestRuntime(ctx.db);
		const target = await runtime.handleContentCreate("posts", {
			data: { title: "Target" },
			locale: "en",
		});
		if (!target.success) throw new Error(target.error.message);
		const source = await runtime.handleContentCreate("posts", {
			data: { title: "Hello", author: target.data.item.id },
			locale: "en",
		});
		if (!source.success) throw new Error(source.error.message);

		await new RelationRepository(ctx.db).create({
			slug: "posts_author",
			parentCollection: "posts",
			childCollection: "posts",
			parentLabel: "Author",
			childLabel: "Posts",
		});
		await ctx.db
			.updateTable("_emdash_fields")
			.set({
				validation: JSON.stringify({
					relation: "posts_author",
					relationSide: "parent",
					targetCollection: "posts",
				}),
			})
			.where("slug", "=", "author")
			.execute();

		const translation = await runtime.handleContentCreate("posts", {
			data: { title: "Bonjour" },
			locale: "fr",
			translationOf: source.data.item.id,
		});

		expect(translation.success).toBe(true);
	});
});

describeEachDialect("setReferenceSelection", (dialect) => {
	let ctx: DialectTestContext;

	it("sets children on a successful call; a child outside the child collection is NOT_FOUND with no partial write", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

			const relationRepo = new RelationRepository(ctx.db);
			const relation = await relationRepo.create({
				slug: "related_posts",
				parentCollection: "posts",
				childCollection: "posts",
				parentLabel: "Related posts",
				childLabel: "Related to",
			});
			await registry.createField("posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: { relation: relation.slug, relationSide: "parent", targetCollection: "posts" },
			});

			const parent = await handleContentCreate(ctx.db, "posts", { data: { title: "Parent" } });
			const childA = await handleContentCreate(ctx.db, "posts", { data: { title: "Child A" } });
			const childB = await handleContentCreate(ctx.db, "posts", { data: { title: "Child B" } });
			expect(parent.success).toBe(true);
			expect(childA.success).toBe(true);
			expect(childB.success).toBe(true);
			if (!parent.success || !childA.success || !childB.success) return;

			const result = await setReferenceSelection(ctx.db, "posts", parent.data.item.id, "related", [
				childA.data.item.id,
				childB.data.item.id,
			]);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.relationId).toBe(relation.id);

				const page = await relationRepo.getChildrenPage(
					result.data.relationId,
					result.data.entryGroup,
				);
				expect(page.items.map((i) => i.childGroup).toSorted()).toEqual(
					[childA.data.item.id, childB.data.item.id].toSorted(),
				);
			}

			// A child id outside the relation's child collection fails NOT_FOUND —
			// and must not partially overwrite the set above.
			const bad = await setReferenceSelection(ctx.db, "posts", parent.data.item.id, "related", [
				"nope",
			]);
			expect(bad.success).toBe(false);
			if (!bad.success) expect(bad.error.code).toBe("NOT_FOUND");

			const pageAfterBad = await relationRepo.getChildrenPage(relation.slug, parent.data.item.id);
			expect(pageAfterBad.items.map((i) => i.childGroup).toSorted()).toEqual(
				[childA.data.item.id, childB.data.item.id].toSorted(),
			);
		} finally {
			await teardownForDialect(ctx);
		}
	});
});

describeEachDialect("content create with a `references` key", (dialect) => {
	let ctx: DialectTestContext;

	it("writes reference edges atomically with the entry on create", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

			const relationRepo = new RelationRepository(ctx.db);
			const relation = await relationRepo.create({
				slug: "related_posts",
				parentCollection: "posts",
				childCollection: "posts",
				parentLabel: "Related posts",
				childLabel: "Related to",
			});
			// A selection is addressed by field slug, so the field that views the
			// relation has to exist.
			await registry.createField("posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: { relation: relation.slug, targetCollection: "posts", multiple: true },
			});

			const childA = await handleContentCreate(ctx.db, "posts", { data: { title: "Child A" } });
			const childB = await handleContentCreate(ctx.db, "posts", { data: { title: "Child B" } });
			expect(childA.success).toBe(true);
			expect(childB.success).toBe(true);
			if (!childA.success || !childB.success) return;

			const res = await handleContentCreate(ctx.db, "posts", {
				data: { title: "Parent" },
				references: { related: [childA.data.item.id, childB.data.item.id] },
			});
			expect(res.success).toBe(true);
			if (!res.success) return;

			// Read back through the same edge read the REST endpoint uses —
			// order must match the input array (sort_order is positional).
			const page = await relationRepo.getChildrenPage(relation.slug, res.data.item.id);
			expect(page.items.map((i) => i.childGroup)).toEqual([
				childA.data.item.id,
				childB.data.item.id,
			]);
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("rejects the whole save when a reference child is invalid", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

			const relationRepo = new RelationRepository(ctx.db);
			const relation = await relationRepo.create({
				slug: "related_posts",
				parentCollection: "posts",
				childCollection: "posts",
				parentLabel: "Related posts",
				childLabel: "Related to",
			});
			await registry.createField("posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: { relation: relation.slug, targetCollection: "posts", multiple: true },
			});

			const contentRepo = new ContentRepository(ctx.db);
			const countBefore = await contentRepo.count("posts");

			const res = await handleContentCreate(ctx.db, "posts", {
				data: { title: "Parent" },
				references: { related: ["does-not-exist"] },
			});
			expect(res.success).toBe(false);
			if (!res.success) expect(res.error.code).toBe("NOT_FOUND");

			// The entry must NOT be persisted — a bad reference aborts the whole
			// transaction, not just the reference write, so no half-written entry.
			const countAfter = await contentRepo.count("posts");
			expect(countAfter).toBe(countBefore);
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("resolves the references before writing anything, since D1 cannot roll back", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

			const relationRepo = new RelationRepository(ctx.db);
			const relation = await relationRepo.create({
				slug: "related_posts",
				parentCollection: "posts",
				childCollection: "posts",
				parentLabel: "Related posts",
				childLabel: "Related to",
			});
			await registry.createField("posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: { relation: relation.slug, targetCollection: "posts", multiple: true },
			});

			// Handed a transaction, `withTransaction` runs the handler inline: its
			// statements land one after another with no rollback boundary between
			// them, which is what D1 does. Reading from inside that transaction shows
			// what a rejected save would leave behind there.
			await ctx.db.transaction().execute(async (trx) => {
				const res = await handleContentCreate(trx, "posts", {
					data: { title: "Parent" },
					references: { related: ["does-not-exist"] },
				});
				expect(res.success).toBe(false);
				if (!res.success) expect(res.error.code).toBe("NOT_FOUND");

				expect(await new ContentRepository(trx).count("posts")).toBe(0);
			});
		} finally {
			await teardownForDialect(ctx);
		}
	});
});

describeEachDialect("a reference field bound to the child side of its relation", (dialect) => {
	let ctx: DialectTestContext;

	/** `posts.author` picks an author; `authors.posts` views the same links back. */
	async function setupBothSides() {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createCollection({ slug: "authors", label: "Authors", labelSingular: "Author" });
		await registry.createField("authors", { slug: "name", label: "Name", type: "string" });

		const relation = await new RelationRepository(ctx.db).create({
			slug: "post_authors",
			parentCollection: "posts",
			childCollection: "authors",
			parentLabel: "Posts",
			childLabel: "Author",
			maxChildrenPerParent: 1,
		});
		await registry.createField("posts", {
			slug: "author",
			label: "Author",
			type: "reference",
			validation: {
				relation: relation.slug,
				relationSide: "parent",
				targetCollection: "authors",
			},
		});
		await registry.createField("authors", {
			slug: "posts",
			label: "Posts",
			type: "reference",
			validation: {
				relation: relation.slug,
				relationSide: "child",
				targetCollection: "posts",
			},
		});
		return relation;
	}

	it("writes the links from the child end and reads them back on both fields", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const relation = await setupBothSides();

			const first = await handleContentCreate(ctx.db, "posts", { data: { title: "First" } });
			const second = await handleContentCreate(ctx.db, "posts", { data: { title: "Second" } });
			const author = await handleContentCreate(ctx.db, "authors", { data: { name: "Jane" } });
			if (!first.success || !second.success || !author.success) throw new Error("setup failed");

			// Selecting from the child end names the parents pointing at this entry.
			const updated = await handleContentUpdate(ctx.db, "authors", author.data.item.id, {
				references: { posts: [first.data.item.id, second.data.item.id] },
			});
			expect(updated, JSON.stringify(updated)).toMatchObject({ success: true });

			const hydratedAuthor = await handleContentGet(
				ctx.db,
				"authors",
				author.data.item.id,
				undefined,
				{ includeDrafts: true },
			);
			if (!hydratedAuthor.success) throw new Error("author read failed");
			// The child side is unordered by design: `sort_order` positions children
			// within one parent and has no symmetric counterpart, so this list comes
			// back by link id. Two links written in the same millisecond carry ULIDs
			// whose order is not the write order, so assert the set, not a sequence.
			expect(
				hydratedAuthor.data.item.references?.posts?.children.map((c) => c.id).toSorted(),
			).toEqual([first.data.item.id, second.data.item.id].toSorted());

			// The same links seen from the parent end, through the other field.
			const hydratedPost = await handleContentGet(ctx.db, "posts", first.data.item.id, undefined, {
				includeDrafts: true,
			});
			if (!hydratedPost.success) throw new Error("post read failed");
			expect(hydratedPost.data.item.references?.author?.children.map((c) => c.id)).toEqual([
				author.data.item.id,
			]);

			const repo = new RelationRepository(ctx.db);
			const edges = await repo.getParents(relation.id, author.data.item.translationGroup!);
			expect(edges).toHaveLength(2);
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("enforces the child side's own limit, not the parent side's", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const relation = await setupBothSides();
			// One author per post, but a post may be linked from one author only too.
			await new RelationRepository(ctx.db).update(relation.id, { maxParentsPerChild: 1 });

			const first = await handleContentCreate(ctx.db, "posts", { data: { title: "First" } });
			const second = await handleContentCreate(ctx.db, "posts", { data: { title: "Second" } });
			const author = await handleContentCreate(ctx.db, "authors", { data: { name: "Jane" } });
			if (!first.success || !second.success || !author.success) throw new Error("setup failed");

			const rejected = await handleContentUpdate(ctx.db, "authors", author.data.item.id, {
				references: { posts: [first.data.item.id, second.data.item.id] },
			});
			expect(rejected).toMatchObject({
				success: false,
				error: { code: "VALIDATION_ERROR" },
			});
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("rejects a references key that is not a reference field", async () => {
		ctx = await setupForDialect(dialect);
		try {
			await setupBothSides();
			const post = await handleContentCreate(ctx.db, "posts", { data: { title: "First" } });
			if (!post.success) throw new Error("setup failed");

			const rejected = await handleContentUpdate(ctx.db, "posts", post.data.item.id, {
				references: { title: ["whatever"] },
			});
			expect(rejected).toMatchObject({
				success: false,
				error: { code: "VALIDATION_ERROR" },
			});
		} finally {
			await teardownForDialect(ctx);
		}
	});
});

describeEachDialect("handleContentGet reference hydration (opt-in)", (dialect) => {
	let ctx: DialectTestContext;

	it("hydrates the first page of references when referenceOptions is passed", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

			const relationRepo = new RelationRepository(ctx.db);
			const relation = await relationRepo.create({
				slug: "related_posts",
				parentCollection: "posts",
				childCollection: "posts",
				parentLabel: "Related posts",
				childLabel: "Related to",
			});

			// The reference field must carry validation.relation + targetCollection
			// so hydration can discover it and its child collection.
			await registry.createField("posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: {
					relation: relation.slug,
					targetCollection: "posts",
					multiple: true,
				},
			});

			const childA = await handleContentCreate(ctx.db, "posts", { data: { title: "Child A" } });
			const childB = await handleContentCreate(ctx.db, "posts", { data: { title: "Child B" } });
			expect(childA.success && childB.success).toBe(true);
			if (!childA.success || !childB.success) return;

			const parent = await handleContentCreate(ctx.db, "posts", {
				data: { title: "Parent" },
				references: { related: [childA.data.item.id, childB.data.item.id] },
			});
			expect(parent.success).toBe(true);
			if (!parent.success) return;

			const got = await handleContentGet(ctx.db, "posts", parent.data.item.id, undefined, {
				includeDrafts: true,
			});
			expect(got.success).toBe(true);
			if (got.success) {
				const refs = got.data.item.references?.related;
				expect(refs?.children.map((c) => c.id)).toEqual([childA.data.item.id, childB.data.item.id]);
			}
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("hydrates nothing for a legacy reference field with no validation.relation", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
			// Legacy reference field: validation without `relation`/`targetCollection`.
			await registry.createField("posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: { multiple: true },
			});

			const parent = await handleContentCreate(ctx.db, "posts", { data: { title: "Parent" } });
			expect(parent.success).toBe(true);
			if (!parent.success) return;

			const got = await handleContentGet(ctx.db, "posts", parent.data.item.id, undefined, {
				includeDrafts: true,
			});
			expect(got.success).toBe(true);
			if (got.success) {
				// No crash; the legacy field contributes no reference group.
				expect(got.data.item.references).toEqual({});
			}
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("does not hydrate references when referenceOptions is omitted (opt-in)", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

			const relationRepo = new RelationRepository(ctx.db);
			const relation = await relationRepo.create({
				slug: "related_posts",
				parentCollection: "posts",
				childCollection: "posts",
				parentLabel: "Related posts",
				childLabel: "Related to",
			});
			await registry.createField("posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: {
					relation: relation.slug,
					targetCollection: "posts",
					multiple: true,
				},
			});

			const child = await handleContentCreate(ctx.db, "posts", { data: { title: "Child" } });
			expect(child.success).toBe(true);
			if (!child.success) return;

			const parent = await handleContentCreate(ctx.db, "posts", {
				data: { title: "Parent" },
				references: { related: [child.data.item.id] },
			});
			expect(parent.success).toBe(true);
			if (!parent.success) return;

			// Omit the 5th arg → no hydration, no extra queries.
			const got = await handleContentGet(ctx.db, "posts", parent.data.item.id);
			expect(got.success).toBe(true);
			if (got.success) {
				expect(got.data.item.references).toBeUndefined();
			}
		} finally {
			await teardownForDialect(ctx);
		}
	});
});

describeEachDialect("handleContentDuplicate copies reference edges", (dialect) => {
	let ctx: DialectTestContext;

	it("carries the original's outgoing references onto the duplicate", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

			const relationRepo = new RelationRepository(ctx.db);
			const relation = await relationRepo.create({
				slug: "related_posts",
				parentCollection: "posts",
				childCollection: "posts",
				parentLabel: "Related posts",
				childLabel: "Related to",
			});
			await registry.createField("posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: { relation: relation.slug, relationSide: "parent", targetCollection: "posts" },
			});

			const parent = await handleContentCreate(ctx.db, "posts", { data: { title: "Parent" } });
			const childA = await handleContentCreate(ctx.db, "posts", { data: { title: "Child A" } });
			const childB = await handleContentCreate(ctx.db, "posts", { data: { title: "Child B" } });
			expect(parent.success && childA.success && childB.success).toBe(true);
			if (!parent.success || !childA.success || !childB.success) return;

			const set = await setReferenceSelection(ctx.db, "posts", parent.data.item.id, "related", [
				childA.data.item.id,
				childB.data.item.id,
			]);
			expect(set.success).toBe(true);

			const dup = await handleContentDuplicate(ctx.db, "posts", parent.data.item.id);
			expect(dup.success).toBe(true);
			if (!dup.success) return;

			// The duplicate is a distinct entry (new translation_group) but must carry
			// the same outgoing reference edges, in order.
			const content = new ContentRepository(ctx.db);
			const dupItem = await content.findById("posts", dup.data.item.id);
			expect(dupItem?.translationGroup).toBeTruthy();
			expect(dupItem?.translationGroup).not.toBe(parent.data.item.id);
			if (!dupItem?.translationGroup) return;

			const page = await relationRepo.getChildrenPage(relation.slug, dupItem.translationGroup);
			expect(page.items.map((i) => i.childGroup)).toEqual([
				childA.data.item.id,
				childB.data.item.id,
			]);
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("refuses the duplicate when copying its children would pass their parent limit", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

			const relationRepo = new RelationRepository(ctx.db);
			// One parent per child, so a copy of the parent cannot also hold them.
			const relation = await relationRepo.create({
				slug: "related_posts",
				parentCollection: "posts",
				childCollection: "posts",
				parentLabel: "Related posts",
				childLabel: "Related to",
				maxParentsPerChild: 1,
			});
			await registry.createField("posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: { relation: relation.slug, relationSide: "parent", targetCollection: "posts" },
			});

			const parent = await handleContentCreate(ctx.db, "posts", { data: { title: "Parent" } });
			const child = await handleContentCreate(ctx.db, "posts", { data: { title: "Child" } });
			expect(parent.success && child.success).toBe(true);
			if (!parent.success || !child.success) return;
			expect(
				(
					await setReferenceSelection(ctx.db, "posts", parent.data.item.id, "related", [
						child.data.item.id,
					])
				).success,
			).toBe(true);

			const dup = await handleContentDuplicate(ctx.db, "posts", parent.data.item.id);
			expect(dup.success).toBe(false);
			if (dup.success) return;
			expect(dup.error.code).toBe("VALIDATION_ERROR");

			// The child keeps the one parent the relation allows it.
			const parents = await relationRepo.getParentsPage(relation.slug, child.data.item.id);
			expect(parents.items.map((i) => i.parentGroup)).toEqual([parent.data.item.id]);
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("refuses the duplicate when copying its parents would pass their child limit", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

			const relationRepo = new RelationRepository(ctx.db);
			// One child per parent, so a copy of the child has no room under it.
			const relation = await relationRepo.create({
				slug: "related_posts",
				parentCollection: "posts",
				childCollection: "posts",
				parentLabel: "Related posts",
				childLabel: "Related to",
				maxChildrenPerParent: 1,
			});
			// The field views the child end, so the duplicate has to carry its parents.
			await registry.createField("posts", {
				slug: "related_to",
				label: "Related to",
				type: "reference",
				validation: { relation: relation.slug, relationSide: "child", targetCollection: "posts" },
			});

			const parent = await handleContentCreate(ctx.db, "posts", { data: { title: "Parent" } });
			const child = await handleContentCreate(ctx.db, "posts", { data: { title: "Child" } });
			expect(parent.success && child.success).toBe(true);
			if (!parent.success || !child.success) return;
			expect(
				(
					await setReferenceSelection(ctx.db, "posts", child.data.item.id, "related_to", [
						parent.data.item.id,
					])
				).success,
			).toBe(true);

			const dup = await handleContentDuplicate(ctx.db, "posts", child.data.item.id);
			expect(dup.success).toBe(false);
			if (dup.success) return;
			expect(dup.error.code).toBe("VALIDATION_ERROR");

			// The parent keeps the one child the relation allows it.
			const children = await relationRepo.getChildrenPage(relation.slug, parent.data.item.id);
			expect(children.items.map((i) => i.childGroup)).toEqual([child.data.item.id]);
		} finally {
			await teardownForDialect(ctx);
		}
	});
});

describeEachDialect("handleContentPermanentDelete clears reference edges", (dialect) => {
	let ctx: DialectTestContext;

	async function setupPostsWithRelation(db: DialectTestContext["db"]) {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

		const relationRepo = new RelationRepository(db);
		const relation = await relationRepo.create({
			slug: "related_posts",
			parentCollection: "posts",
			childCollection: "posts",
			parentLabel: "Related posts",
			childLabel: "Related to",
		});
		await registry.createField("posts", {
			slug: "related",
			label: "Related",
			type: "reference",
			validation: { relation: relation.slug, relationSide: "parent", targetCollection: "posts" },
		});
		return { relationRepo, relation };
	}

	it("removes edges on both sides when the last row of a translation group is purged", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const { relationRepo, relation } = await setupPostsWithRelation(ctx.db);

			const parent = await handleContentCreate(ctx.db, "posts", { data: { title: "Parent" } });
			const middle = await handleContentCreate(ctx.db, "posts", { data: { title: "Middle" } });
			const child = await handleContentCreate(ctx.db, "posts", { data: { title: "Child" } });
			expect(parent.success && middle.success && child.success).toBe(true);
			if (!parent.success || !middle.success || !child.success) return;

			// The purged entry sits in the middle of a chain: parent → middle → child,
			// so both its outgoing and incoming edges must go.
			expect(
				(
					await setReferenceSelection(ctx.db, "posts", parent.data.item.id, "related", [
						middle.data.item.id,
					])
				).success,
			).toBe(true);
			expect(
				(
					await setReferenceSelection(ctx.db, "posts", middle.data.item.id, "related", [
						child.data.item.id,
					])
				).success,
			).toBe(true);

			expect((await handleContentDelete(ctx.db, "posts", middle.data.item.id)).success).toBe(true);
			const purged = await handleContentPermanentDelete(ctx.db, "posts", middle.data.item.id);
			expect(purged.success).toBe(true);

			const outgoing = await relationRepo.getChildrenPage(relation.slug, middle.data.item.id);
			expect(outgoing.items).toEqual([]);
			const incoming = await relationRepo.getParentsPage(relation.slug, middle.data.item.id);
			expect(incoming.items).toEqual([]);
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("keeps the group's edges when a translation sibling survives the purge", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const { relationRepo, relation } = await setupPostsWithRelation(ctx.db);

			const parent = await handleContentCreate(ctx.db, "posts", { data: { title: "Parent" } });
			const child = await handleContentCreate(ctx.db, "posts", { data: { title: "Child" } });
			expect(parent.success && child.success).toBe(true);
			if (!parent.success || !child.success) return;

			const translation = await handleContentCreate(ctx.db, "posts", {
				data: { title: "Parent (fr)" },
				locale: "fr",
				translationOf: parent.data.item.id,
			});
			expect(translation.success).toBe(true);
			if (!translation.success) return;

			expect(
				(
					await setReferenceSelection(ctx.db, "posts", parent.data.item.id, "related", [
						child.data.item.id,
					])
				).success,
			).toBe(true);

			// Edges are keyed by translation_group, so purging one locale row must not
			// strip references still owned by its surviving sibling.
			expect((await handleContentDelete(ctx.db, "posts", translation.data.item.id)).success).toBe(
				true,
			);
			const purged = await handleContentPermanentDelete(ctx.db, "posts", translation.data.item.id);
			expect(purged.success).toBe(true);

			const page = await relationRepo.getChildrenPage(relation.slug, parent.data.item.id);
			expect(page.items.map((i) => i.childGroup)).toEqual([child.data.item.id]);
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("keeps a live entry's links when permanent delete refuses the row", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const { relationRepo, relation } = await setupPostsWithRelation(ctx.db);

			const parent = await handleContentCreate(ctx.db, "posts", { data: { title: "Parent" } });
			const child = await handleContentCreate(ctx.db, "posts", { data: { title: "Child" } });
			expect(parent.success && child.success).toBe(true);
			if (!parent.success || !child.success) return;
			expect(
				(
					await setReferenceSelection(ctx.db, "posts", parent.data.item.id, "related", [
						child.data.item.id,
					])
				).success,
			).toBe(true);

			// The entry was never trashed, so `permanentDelete` refuses it.
			const purged = await handleContentPermanentDelete(ctx.db, "posts", parent.data.item.id);
			expect(purged.success).toBe(false);

			const repo = new ContentRepository(ctx.db);
			expect(await repo.findById("posts", parent.data.item.id)).not.toBeNull();
			const page = await relationRepo.getChildrenPage(relation.slug, parent.data.item.id);
			expect(page.items.map((i) => i.childGroup)).toEqual([child.data.item.id]);
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("keeps the row when its edges cannot be cleared, so nothing is orphaned", async () => {
		ctx = await setupForDialect(dialect);
		try {
			await setupPostsWithRelation(ctx.db);

			const parent = await handleContentCreate(ctx.db, "posts", { data: { title: "Parent" } });
			const child = await handleContentCreate(ctx.db, "posts", { data: { title: "Child" } });
			if (!parent.success || !child.success) return;
			await setReferenceSelection(ctx.db, "posts", parent.data.item.id, "related", [
				child.data.item.id,
			]);
			await handleContentDelete(ctx.db, "posts", parent.data.item.id);

			// The row is the only way back to the edges keyed by its translation
			// group. With the link table gone the cleanup cannot run, and the
			// handler executes inline — D1's boundary — so a row deleted first
			// would be gone for good with its edges left behind.
			await sql`DROP TABLE ${sql.ref("_emdash_content_references")}`.execute(ctx.db);

			const inline = asInlineTransaction(ctx.db);
			const purged = await handleContentPermanentDelete(inline, "posts", parent.data.item.id);
			expect(purged.success).toBe(false);

			const repo = new ContentRepository(ctx.db);
			expect(await repo.findByIdIncludingTrashed("posts", parent.data.item.id)).not.toBeNull();
		} finally {
			await teardownForDialect(ctx);
		}
	});
});
