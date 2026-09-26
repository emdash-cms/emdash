/**
 * Regression for #3469: publishing a draft on one end of a relation must not
 * undo live-link changes published from the opposite reference field in the
 * meantime.
 *
 * Both ends of a many-to-many-ish relation have a reference field. A draft that
 * stages a selection represents only the delta it intended; publication should
 * merge it with concurrent changes rather than replace the live edge set.
 */

import { afterEach, beforeEach, expect, it } from "vitest";

import { handleContentCreate } from "../../../src/api/handlers/content.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
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

	async function createAuthor(name: string) {
		const result = await handleContentCreate(ctx.db, "authors", {
			data: { name },
			slug: name.toLowerCase().replaceAll(" ", "-"),
		});
		if (!result.success) throw new Error(`Author setup failed: ${result.error.message}`);
		const published = await runtime.handleContentPublish("authors", result.data.item.id);
		if (!published.success) throw new Error("Author publish failed");
		return result.data.item;
	}

	async function createPost(title: string, authorIds?: string[]) {
		const create = await runtime.handleContentCreate("posts", {
			data: { title },
			slug: title.toLowerCase().replaceAll(" ", "-"),
			references: authorIds ? { author: authorIds } : undefined,
		});
		if (!create.success) throw new Error(`Post setup failed: ${create.error.message}`);
		return create.data.item;
	}

	async function parentGroupsFor(childGroup: string): Promise<string[]> {
		const parents = await new RelationRepository(ctx.db).getParents("posts_authors", childGroup);
		return parents.map((edge) => edge.parentGroup);
	}

	async function childrenGroupsFor(parentGroup: string): Promise<string[]> {
		const children = await new RelationRepository(ctx.db).getChildren("posts_authors", parentGroup);
		return children.map((edge) => edge.childGroup);
	}

	it("reproduces #3469: publishing the child side keeps links added from the parent side", async () => {
		const ada = await createAuthor("Ada");
		const postOne = await createPost("Post one", [ada.id]);
		const postTwo = await createPost("Post two");

		// Publish Post one -> Ada from the parent side.
		const postOnePublished = await runtime.handleContentPublish("posts", postOne.id);
		expect(postOnePublished.success).toBe(true);

		// Ada now has one live parent (Post one). The author-side field may not show
		// it in the current editor, so the draft only stages Post two.
		const saved = await runtime.handleContentUpdate("authors", ada.id, {
			references: { posts: [postTwo.id] },
		});
		expect(saved.success).toBe(true);

		// Publish Ada. The draft added Post two; the parent-side link to Post one
		// should survive because a child-side draft only adds, never removes.
		const published = await runtime.handleContentPublish("authors", ada.id);
		expect(published.success).toBe(true);

		// Post one should still reference Ada.
		const postOneAfter = await new ContentRepository(ctx.db).findById("posts", postOne.id);
		const postOneAuthors = await childrenGroupsFor(postOneAfter!.translationGroup!);
		expect(postOneAuthors).toEqual([ada.translationGroup]);

		// Ada should reference both posts.
		await expect(parentGroupsFor(ada.translationGroup)).resolves.toEqual([
			postOne.translationGroup,
			postTwo.translationGroup,
		]);
	});

	it("reproduces #3469 reverse: publishing the child side does not revive a removed parent-side link", async () => {
		const ada = await createAuthor("Ada");
		const postOne = await createPost("Post one", [ada.id]);
		const postTwo = await createPost("Post two");

		await runtime.handleContentPublish("posts", postOne.id);

		// On Ada, stage both posts (live one plus a new one).
		const saved = await runtime.handleContentUpdate("authors", ada.id, {
			references: { posts: [postOne.id, postTwo.id] },
		});
		expect(saved.success).toBe(true);

		// Before publishing Ada, remove Ada from Post one from the parent side.
		const removed = await runtime.handleContentUpdate("posts", postOne.id, {
			references: { author: [] },
		});
		expect(removed.success).toBe(true);
		const postOneRepublished = await runtime.handleContentPublish("posts", postOne.id);
		expect(postOneRepublished.success).toBe(true);

		// Publishing Ada must not re-link Post one.
		const published = await runtime.handleContentPublish("authors", ada.id);
		expect(published.success).toBe(true);

		const postOneAfter = await new ContentRepository(ctx.db).findById("posts", postOne.id);
		const postOneAuthors = await childrenGroupsFor(postOneAfter!.translationGroup!);
		expect(postOneAuthors).toEqual([]);

		await expect(parentGroupsFor(ada.translationGroup)).resolves.toEqual([
			postTwo.translationGroup,
		]);
	});
});
