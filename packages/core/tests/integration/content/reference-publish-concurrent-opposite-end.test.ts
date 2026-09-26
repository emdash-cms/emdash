import { afterEach, beforeEach, expect, it } from "vitest";

import { handleContentCreate } from "../../../src/api/handlers/content.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { ContentItem } from "../../../src/database/repositories/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("concurrent opposite-end reference publish", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);

		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createCollection({
			slug: "authors",
			label: "Authors",
			labelSingular: "Author",
		});
		await registry.createField("authors", { slug: "name", label: "Name", type: "string" });

		const relations = new RelationRepository(ctx.db);
		await relations.create({
			slug: "posts_authors",
			parentCollection: "posts",
			childCollection: "authors",
			parentLabel: "Posts",
			childLabel: "Authors",
		});

		await registry.createField("posts", {
			slug: "author",
			label: "Author",
			type: "reference",
			validation: {
				relation: "posts_authors",
				relationSide: "parent",
				targetCollection: "authors",
			},
		});
		await registry.createField("authors", {
			slug: "posts",
			label: "Posts",
			type: "reference",
			validation: {
				relation: "posts_authors",
				relationSide: "child",
				targetCollection: "posts",
			},
		});

		runtime = createTestRuntime(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createAuthor(name: string): Promise<ContentItem> {
		const created = await handleContentCreate(ctx.db, "authors", {
			data: { name },
			slug: name.toLowerCase().replaceAll(" ", "-"),
		});
		if (!created.success) throw new Error(`Author setup failed: ${created.error.message}`);
		const published = await runtime.handleContentPublish("authors", created.data.item.id);
		if (!published.success) throw new Error("Author publish failed");
		return created.data.item;
	}

	async function createPost(title: string, authorIds: string[] = []): Promise<ContentItem> {
		const created = await runtime.handleContentCreate("posts", {
			data: { title },
			slug: title.toLowerCase().replaceAll(" ", "-"),
			references: { author: authorIds },
		});
		if (!created.success) throw new Error(`Post setup failed: ${created.error.message}`);
		const published = await runtime.handleContentPublish("posts", created.data.item.id);
		if (!published.success) throw new Error("Post publish failed");
		return created.data.item;
	}

	async function saveAndPublish(
		collection: "authors" | "posts",
		id: string,
		references: Record<string, string[]>,
	): Promise<void> {
		const saved = await runtime.handleContentUpdate(collection, id, { references });
		expect(saved.success).toBe(true);
		const published = await runtime.handleContentPublish(collection, id);
		expect(published.success).toBe(true);
	}

	async function parentGroupsFor(childGroup: string): Promise<string[]> {
		const parents = await new RelationRepository(ctx.db).getParents("posts_authors", childGroup);
		return parents.map((edge) => edge.parentGroup);
	}

	async function childGroupsFor(parentGroup: string): Promise<string[]> {
		const children = await new RelationRepository(ctx.db).getChildren("posts_authors", parentGroup);
		return children.map((edge) => edge.childGroup);
	}

	it("applies additions and removals staged from the parent side", async () => {
		const [ada, grace] = [await createAuthor("Ada"), await createAuthor("Grace")];
		const post = await createPost("Post", [ada.id]);

		await saveAndPublish("posts", post.id, { author: [grace.id] });

		await expect(childGroupsFor(post.translationGroup)).resolves.toEqual([grace.translationGroup]);
		await expect(parentGroupsFor(ada.translationGroup)).resolves.toEqual([]);
	});

	it("applies additions and removals staged from the child side", async () => {
		const ada = await createAuthor("Ada");
		const [postOne, postTwo] = [await createPost("Post one"), await createPost("Post two")];
		await saveAndPublish("authors", ada.id, { posts: [postOne.id] });

		await saveAndPublish("authors", ada.id, { posts: [postTwo.id] });

		await expect(parentGroupsFor(ada.translationGroup)).resolves.toEqual([
			postTwo.translationGroup,
		]);
		await expect(childGroupsFor(postOne.translationGroup)).resolves.toEqual([]);
	});

	it("keeps a child-side addition while publishing a parent-side draft", async () => {
		const [ada, grace] = [await createAuthor("Ada"), await createAuthor("Grace")];
		const post = await createPost("Post");
		const saved = await runtime.handleContentUpdate("posts", post.id, {
			references: { author: [ada.id] },
		});
		expect(saved.success).toBe(true);

		await saveAndPublish("authors", grace.id, { posts: [post.id] });
		const published = await runtime.handleContentPublish("posts", post.id);
		expect(published.success).toBe(true);

		await expect(childGroupsFor(post.translationGroup)).resolves.toEqual([
			ada.translationGroup,
			grace.translationGroup,
		]);
	});

	it("keeps a parent-side addition while publishing a child-side draft", async () => {
		const ada = await createAuthor("Ada");
		const [postOne, postTwo] = [await createPost("Post one"), await createPost("Post two")];
		const saved = await runtime.handleContentUpdate("authors", ada.id, {
			references: { posts: [postOne.id] },
		});
		expect(saved.success).toBe(true);

		await saveAndPublish("posts", postTwo.id, { author: [ada.id] });
		const published = await runtime.handleContentPublish("authors", ada.id);
		expect(published.success).toBe(true);

		const parents = await parentGroupsFor(ada.translationGroup);
		expect(parents).toHaveLength(2);
		expect(parents).toEqual(
			expect.arrayContaining([postOne.translationGroup, postTwo.translationGroup]),
		);
	});

	it("keeps a child-side removal while publishing a parent-side draft", async () => {
		const [ada, grace] = [await createAuthor("Ada"), await createAuthor("Grace")];
		const post = await createPost("Post", [ada.id, grace.id]);
		const saved = await runtime.handleContentUpdate("posts", post.id, {
			references: { author: [ada.id, grace.id] },
		});
		expect(saved.success).toBe(true);

		await saveAndPublish("authors", grace.id, { posts: [] });
		const published = await runtime.handleContentPublish("posts", post.id);
		expect(published.success).toBe(true);

		await expect(childGroupsFor(post.translationGroup)).resolves.toEqual([ada.translationGroup]);
	});

	it("keeps a parent-side removal while publishing a child-side draft", async () => {
		const ada = await createAuthor("Ada");
		const [postOne, postTwo] = [
			await createPost("Post one", [ada.id]),
			await createPost("Post two", [ada.id]),
		];
		const saved = await runtime.handleContentUpdate("authors", ada.id, {
			references: { posts: [postOne.id, postTwo.id] },
		});
		expect(saved.success).toBe(true);

		await saveAndPublish("posts", postTwo.id, { author: [] });
		const published = await runtime.handleContentPublish("authors", ada.id);
		expect(published.success).toBe(true);

		await expect(parentGroupsFor(ada.translationGroup)).resolves.toEqual([
			postOne.translationGroup,
		]);
	});

	it("validates the merged selection against the current near-side limit", async () => {
		const relation = await new RelationRepository(ctx.db).findBySlug("posts_authors");
		if (!relation) throw new Error("Relation setup failed");
		await new RelationRepository(ctx.db).update(relation.id, { maxChildrenPerParent: 1 });

		const [ada, grace] = [await createAuthor("Ada"), await createAuthor("Grace")];
		const post = await createPost("Post");
		const saved = await runtime.handleContentUpdate("posts", post.id, {
			references: { author: [ada.id] },
		});
		expect(saved.success).toBe(true);
		await saveAndPublish("authors", grace.id, { posts: [post.id] });

		const published = await runtime.handleContentPublish("posts", post.id);
		expect(published).toMatchObject({
			success: false,
			error: { code: "VALIDATION_ERROR" },
		});
		await expect(childGroupsFor(post.translationGroup)).resolves.toEqual([grace.translationGroup]);
	});

	it("restores a revision's reference selection as an exact replacement", async () => {
		const [ada, grace] = [await createAuthor("Ada"), await createAuthor("Grace")];
		const post = await createPost("Post", [ada.id]);
		const saved = await runtime.handleContentUpdate("posts", post.id, {
			references: { author: [grace.id] },
		});
		expect(saved.success).toBe(true);
		const draft = await new ContentRepository(ctx.db).findById("posts", post.id);
		if (!draft?.draftRevisionId) throw new Error("Draft setup failed");
		const revisionId = draft.draftRevisionId;
		const published = await runtime.handleContentPublish("posts", post.id);
		expect(published.success).toBe(true);
		await saveAndPublish("authors", ada.id, { posts: [post.id] });
		const beforeRestore = await childGroupsFor(post.translationGroup);
		expect(beforeRestore).toHaveLength(2);
		expect(beforeRestore).toEqual(
			expect.arrayContaining([grace.translationGroup, ada.translationGroup]),
		);

		const restored = await runtime.handleRevisionRestore(revisionId, "user-1");
		expect(restored.success).toBe(true);
		const restoredPost = await new ContentRepository(ctx.db).findById("posts", post.id);
		if (!restoredPost?.draftRevisionId) throw new Error("Restored draft setup failed");
		const restoredRevision = await new RevisionRepository(ctx.db).findById(
			restoredPost.draftRevisionId,
		);
		expect(restoredRevision?.data._referencesBaseline).toBeUndefined();

		const republished = await runtime.handleContentPublish("posts", post.id);
		expect(republished.success).toBe(true);
		await expect(childGroupsFor(post.translationGroup)).resolves.toEqual([grace.translationGroup]);
	});
});
