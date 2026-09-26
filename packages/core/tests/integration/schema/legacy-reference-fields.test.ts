import { afterEach, beforeEach, expect, it } from "vitest";

import {
	handleContentCreate,
	handleContentGet,
	handleContentUpdate,
} from "../../../src/api/handlers/content.js";
import { handleSchemaFieldUpdate } from "../../../src/api/handlers/schema.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createLegacyReferenceField } from "../../utils/legacy-reference-field.js";
import { describeEachDialect, setupForDialect, teardownForDialect } from "../../utils/test-db.js";
import type { DialectTestContext } from "../../utils/test-db.js";

describeEachDialect("reference fields that predate relations", (dialect) => {
	let ctx: DialectTestContext;

	async function setup() {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		return registry;
	}

	it("round-trips its value through create and get", async () => {
		await setup();
		try {
			await createLegacyReferenceField(ctx.db, "posts", "author", { targetCollection: "posts" });

			const created = await handleContentCreate(ctx.db, "posts", {
				data: { title: "A", author: "author-entry-id" },
			});
			expect(created.success).toBe(true);
			if (!created.success) return;
			expect(created.data.item.data).toMatchObject({ author: "author-entry-id" });

			const fetched = await handleContentGet(ctx.db, "posts", created.data.item.id);
			expect(fetched.success).toBe(true);
			if (!fetched.success) return;
			expect(fetched.data.item.data).toMatchObject({ author: "author-entry-id" });
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("keeps its value when the entry is updated", async () => {
		await setup();
		try {
			await createLegacyReferenceField(ctx.db, "posts", "author", { targetCollection: "posts" });

			const created = await handleContentCreate(ctx.db, "posts", {
				data: { title: "A", author: "first" },
			});
			if (!created.success) throw new Error("create failed");

			const updated = await handleContentUpdate(ctx.db, "posts", created.data.item.id, {
				data: { author: "second" },
			});
			expect(updated).toMatchObject({ success: true });

			const fetched = await handleContentGet(ctx.db, "posts", created.data.item.id);
			if (!fetched.success) throw new Error("get failed");
			expect(fetched.data.item.data).toMatchObject({ author: "second" });
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("stays editable and filterable when it was indexed before the upgrade", async () => {
		await setup();
		try {
			await createLegacyReferenceField(ctx.db, "posts", "author", {
				targetCollection: "posts",
				indexed: true,
			});

			// An unrelated edit must not be refused because the type left the
			// indexable set.
			const renamed = await handleSchemaFieldUpdate(ctx.db, "posts", "author", {
				label: "Written by",
			});
			expect(renamed).toMatchObject({ success: true });

			const created = await handleContentCreate(ctx.db, "posts", {
				data: { title: "A", author: "author-entry-id" },
			});
			if (!created.success) throw new Error("create failed");

			const content = new ContentRepository(ctx.db);
			const matches = await content.findMany("posts", {
				where: { fieldFilters: { author: "author-entry-id" } },
			});
			expect(matches.items.map((item) => item.id)).toEqual([created.data.item.id]);
		} finally {
			await teardownForDialect(ctx);
		}
	});
});

describeEachDialect("binding a reference field that predates relations", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createCollection({ slug: "authors", label: "Authors", labelSingular: "Author" });
		await registry.createField("authors", { slug: "name", label: "Name", type: "string" });
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("creates the relation and copies the column's ids in as edges", async () => {
		await createLegacyReferenceField(ctx.db, "posts", "author", { targetCollection: "authors" });

		const content = new ContentRepository(ctx.db);
		const author = await content.create({ type: "authors", slug: "jane", data: { name: "Jane" } });
		const post = await content.create({
			type: "posts",
			slug: "hello",
			data: { title: "Hello", author: author.id },
		});

		const res = await handleSchemaFieldUpdate(ctx.db, "posts", "author", {
			validation: { targetCollection: "authors", multiple: false },
		});

		expect(res.success).toBe(true);
		if (!res.success) return;
		expect(res.data.item.validation).toMatchObject({
			relation: "posts_author",
			relationSide: "parent",
			targetCollection: "authors",
		});

		const relation = await new RelationRepository(ctx.db).findBySlug("posts_author");
		expect(relation).toMatchObject({
			parentCollection: "posts",
			childCollection: "authors",
			maxChildrenPerParent: 1,
		});

		const edges = await new RelationRepository(ctx.db).getChildrenPage(
			relation!.id,
			post.translationGroup!,
		);
		expect(edges.items.map((edge) => edge.childGroup)).toEqual([author.translationGroup]);
	});

	it("stops the field being indexed, since nothing writes its column any more", async () => {
		await createLegacyReferenceField(ctx.db, "posts", "author", {
			targetCollection: "authors",
			indexed: true,
		});

		const res = await handleSchemaFieldUpdate(ctx.db, "posts", "author", {
			validation: { targetCollection: "authors" },
		});

		expect(res).toMatchObject({ success: true });
		const field = await new SchemaRegistry(ctx.db).getField("posts", "author");
		expect(field).toMatchObject({ indexed: false, searchable: false });
	});

	it("serves the picker from the edges while the column keeps its pre-binding value", async () => {
		await createLegacyReferenceField(ctx.db, "posts", "author", { targetCollection: "authors" });

		const content = new ContentRepository(ctx.db);
		const author = await content.create({ type: "authors", slug: "jane", data: { name: "Jane" } });
		const post = await content.create({
			type: "posts",
			slug: "hello",
			data: { title: "Hello", author: author.id },
		});

		await handleSchemaFieldUpdate(ctx.db, "posts", "author", {
			validation: { targetCollection: "authors" },
		});

		const fetched = await handleContentGet(ctx.db, "posts", post.id, undefined, {
			includeDrafts: true,
		});
		expect(fetched.success).toBe(true);
		if (!fetched.success) return;
		expect(fetched.data.item.references?.author?.children.map((child) => child.id)).toEqual([
			author.id,
		]);
		// The column is frozen, not cleared: on a site that predates pickers it can
		// hold anything an editor typed, and only the ids that resolved to an entry
		// became edges. Writes no longer reach it, and typegen stops declaring the
		// key, so the edges are the live selection and this is the record of what
		// the field held before it was bound.
		expect(fetched.data.item.data.author).toBe(author.id);
	});

	it("refuses a target collection that does not exist and leaves the field unbound", async () => {
		await createLegacyReferenceField(ctx.db, "posts", "author", { targetCollection: "authors" });

		const res = await handleSchemaFieldUpdate(ctx.db, "posts", "author", {
			validation: { targetCollection: "gone" },
		});

		expect(res).toMatchObject({ success: false, error: { code: "COLLECTION_NOT_FOUND" } });
		const field = await new SchemaRegistry(ctx.db).getField("posts", "author");
		expect(field?.validation?.relation).toBeUndefined();
	});
});
