import { expect, it } from "vitest";

import { handleContentCreate } from "../../../src/api/handlers/content.js";
import { setReferenceChildren } from "../../../src/api/handlers/relations.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { describeEachDialect, setupForDialect, teardownForDialect } from "../../utils/test-db.js";
import type { DialectTestContext } from "../../utils/test-db.js";

describeEachDialect("content write strips storage-less data keys", (dialect) => {
	let ctx: DialectTestContext;

	it("does not error and does not persist a reference key placed in data", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
			await registry.createField("posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: { relation: "grp_x", targetCollection: "posts", multiple: true },
			});

			const res = await handleContentCreate(ctx.db, "posts", {
				data: { title: "A", related: ["should-be-ignored"] },
			});

			expect(res.success).toBe(true);
			if (res.success) {
				// The reference key must not have been written as a column value.
				expect(res.data.item.data).not.toHaveProperty("related");
			}
		} finally {
			await teardownForDialect(ctx);
		}
	});
});

describeEachDialect("setReferenceChildren", (dialect) => {
	let ctx: DialectTestContext;

	it("sets children on a successful call; a child outside the child collection is NOT_FOUND with no partial write", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

			const relationRepo = new RelationRepository(ctx.db);
			const relation = await relationRepo.create({
				name: "related_posts",
				parentCollection: "posts",
				childCollection: "posts",
				parentLabel: "Related posts",
				childLabel: "Related to",
			});

			const parent = await handleContentCreate(ctx.db, "posts", { data: { title: "Parent" } });
			const childA = await handleContentCreate(ctx.db, "posts", { data: { title: "Child A" } });
			const childB = await handleContentCreate(ctx.db, "posts", { data: { title: "Child B" } });
			expect(parent.success).toBe(true);
			expect(childA.success).toBe(true);
			expect(childB.success).toBe(true);
			if (!parent.success || !childA.success || !childB.success) return;

			const result = await setReferenceChildren(
				ctx.db,
				"posts",
				parent.data.item.id,
				relation.translationGroup,
				[childA.data.item.id, childB.data.item.id],
			);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.relationGroup).toBe(relation.translationGroup);

				const page = await relationRepo.getChildrenPage(
					result.data.relationGroup,
					result.data.entryGroup,
				);
				expect(page.items.map((i) => i.childGroup).toSorted()).toEqual(
					[childA.data.item.id, childB.data.item.id].toSorted(),
				);
			}

			// A child id outside the relation's child collection fails NOT_FOUND —
			// and must not partially overwrite the set above.
			const bad = await setReferenceChildren(
				ctx.db,
				"posts",
				parent.data.item.id,
				relation.translationGroup,
				["nope"],
			);
			expect(bad.success).toBe(false);
			if (!bad.success) expect(bad.error.code).toBe("NOT_FOUND");

			const pageAfterBad = await relationRepo.getChildrenPage(
				relation.translationGroup,
				parent.data.item.id,
			);
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
				name: "related_posts",
				parentCollection: "posts",
				childCollection: "posts",
				parentLabel: "Related posts",
				childLabel: "Related to",
			});

			const childA = await handleContentCreate(ctx.db, "posts", { data: { title: "Child A" } });
			const childB = await handleContentCreate(ctx.db, "posts", { data: { title: "Child B" } });
			expect(childA.success).toBe(true);
			expect(childB.success).toBe(true);
			if (!childA.success || !childB.success) return;

			const res = await handleContentCreate(ctx.db, "posts", {
				data: { title: "Parent" },
				references: {
					[relation.translationGroup]: [childA.data.item.id, childB.data.item.id],
				},
			});
			expect(res.success).toBe(true);
			if (!res.success) return;

			// Read back through the same edge read the REST endpoint uses —
			// order must match the input array (sort_order is positional).
			const page = await relationRepo.getChildrenPage(relation.translationGroup, res.data.item.id);
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
				name: "related_posts",
				parentCollection: "posts",
				childCollection: "posts",
				parentLabel: "Related posts",
				childLabel: "Related to",
			});

			const contentRepo = new ContentRepository(ctx.db);
			const countBefore = await contentRepo.count("posts");

			const res = await handleContentCreate(ctx.db, "posts", {
				data: { title: "Parent" },
				references: { [relation.translationGroup]: ["does-not-exist"] },
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
});
