import { expect, it } from "vitest";

import {
	handleSchemaFieldCreate,
	handleSchemaFieldDelete,
	handleSchemaFieldUpdate,
} from "../../../src/api/handlers/schema.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { describeEachDialect, setupForDialect, teardownForDialect } from "../../utils/test-db.js";
import type { DialectTestContext } from "../../utils/test-db.js";

describeEachDialect("reference field lifecycle", (dialect) => {
	let ctx: DialectTestContext;

	it("creates a relation def when a reference field is created and stores its group on the field", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });

			const res = await handleSchemaFieldCreate(ctx.db, "posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: { targetCollection: "posts", multiple: true },
			});

			expect(res.success).toBe(true);

			const repo = new RelationRepository(ctx.db);
			const relations = await repo.list();
			const rel = relations.find((r) => r.name === "posts_related");
			expect(rel).toBeTruthy();
			expect(rel?.parentCollection).toBe("posts");
			expect(rel?.childCollection).toBe("posts");
			if (res.success) {
				expect(res.data.item.validation?.relation).toBe(rel?.translationGroup);
				expect(res.data.item.validation?.targetCollection).toBe("posts");
			}
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("deletes the relation and its edges when the reference field is deleted", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });

			const created = await handleSchemaFieldCreate(ctx.db, "posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: { targetCollection: "posts", multiple: true },
			});
			expect(created.success).toBe(true);
			if (!created.success) return;
			const relationGroup = created.data.item.validation?.relation;
			expect(relationGroup).toBeTruthy();
			if (!relationGroup) return;

			// Seed an edge under the relation so we can assert it's purged too.
			const relRepo = new RelationRepository(ctx.db);
			await relRepo.addReference(relationGroup, "parent-group-x", "child-group-y");
			const edgesBefore = await ctx.db
				.selectFrom("_emdash_content_references")
				.selectAll()
				.where("relation_group", "=", relationGroup)
				.execute();
			expect(edgesBefore.length).toBe(1);

			const del = await handleSchemaFieldDelete(ctx.db, "posts", "related");
			expect(del.success).toBe(true);

			const relations = await relRepo.list();
			expect(relations.find((r) => r.name === "posts_related")).toBeUndefined();

			const edgesAfter = await ctx.db
				.selectFrom("_emdash_content_references")
				.selectAll()
				.where("relation_group", "=", relationGroup)
				.execute();
			expect(edgesAfter.length).toBe(0);

			const field = await registry.getField("posts", "related");
			expect(field).toBeNull();
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("rejects creating a reference field with no target collection", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });

			const res = await handleSchemaFieldCreate(ctx.db, "posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: { multiple: true },
			});

			expect(res.success).toBe(false);
			if (!res.success) expect(res.error.code).toBe("VALIDATION_ERROR");

			const field = await registry.getField("posts", "related");
			expect(field).toBeNull();
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("PATCHes the relation's childLabel when the field's label is updated", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });

			const created = await handleSchemaFieldCreate(ctx.db, "posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: { targetCollection: "posts", multiple: true },
			});
			expect(created.success).toBe(true);
			if (!created.success) return;
			const relationGroup = created.data.item.validation?.relation;
			expect(relationGroup).toBeTruthy();
			if (!relationGroup) return;

			const updated = await handleSchemaFieldUpdate(ctx.db, "posts", "related", {
				label: "Related posts",
			});
			expect(updated.success).toBe(true);

			const relRepo = new RelationRepository(ctx.db);
			const siblings = await relRepo.findTranslations(relationGroup);
			expect(siblings[0]?.childLabel).toBe("Related posts");
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("preserves relation and targetCollection when validation is explicitly null", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });

			const created = await handleSchemaFieldCreate(ctx.db, "posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: { targetCollection: "posts", multiple: true },
			});
			expect(created.success).toBe(true);
			if (!created.success) return;
			const relationGroup = created.data.item.validation?.relation;
			expect(relationGroup).toBeTruthy();
			if (!relationGroup) return;

			const updated = await handleSchemaFieldUpdate(ctx.db, "posts", "related", {
				label: "Related posts",
				validation: null,
			});
			expect(updated.success).toBe(true);

			const field = await registry.getField("posts", "related");
			expect(field?.validation?.relation).toBe(relationGroup);
			expect(field?.validation?.targetCollection).toBe("posts");

			const relRepo = new RelationRepository(ctx.db);
			const relations = await relRepo.list();
			expect(relations.find((r) => r.name === "posts_related")).toBeTruthy();
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("preserves relation and targetCollection when validation omits them", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });

			const created = await handleSchemaFieldCreate(ctx.db, "posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: { targetCollection: "posts", multiple: true },
			});
			expect(created.success).toBe(true);
			if (!created.success) return;
			const relationGroup = created.data.item.validation?.relation;
			expect(relationGroup).toBeTruthy();
			if (!relationGroup) return;

			const updated = await handleSchemaFieldUpdate(ctx.db, "posts", "related", {
				validation: { multiple: false },
			});
			expect(updated.success).toBe(true);

			const field = await registry.getField("posts", "related");
			expect(field?.validation?.relation).toBe(relationGroup);
			expect(field?.validation?.targetCollection).toBe("posts");
			expect(field?.validation?.multiple).toBe(false);

			const relRepo = new RelationRepository(ctx.db);
			const relations = await relRepo.list();
			expect(relations.find((r) => r.name === "posts_related")).toBeTruthy();
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("rejects changing the target collection of an existing reference field", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			await registry.createCollection({ slug: "pages", label: "Pages", labelSingular: "Page" });

			const created = await handleSchemaFieldCreate(ctx.db, "posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: { targetCollection: "posts", multiple: true },
			});
			expect(created.success).toBe(true);

			const updated = await handleSchemaFieldUpdate(ctx.db, "posts", "related", {
				validation: { targetCollection: "pages", multiple: true },
			});
			expect(updated.success).toBe(false);
			if (!updated.success) expect(updated.error.code).toBe("VALIDATION_ERROR");

			// The stored field must be unaffected by the rejected update.
			const field = await registry.getField("posts", "related");
			expect(field?.validation?.targetCollection).toBe("posts");
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("leaves no orphan field row when the relation name cannot be allocated", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });

			// Occupy every name the suffix-retry loop would try (base + _2.._5)
			// so relation allocation is forced to exhaust and fail.
			const relRepo = new RelationRepository(ctx.db);
			const names = [
				"posts_related",
				"posts_related_2",
				"posts_related_3",
				"posts_related_4",
				"posts_related_5",
			];
			for (const name of names) {
				await relRepo.create({
					name,
					parentCollection: "posts",
					childCollection: "posts",
					parentLabel: "Posts",
					childLabel: "Occupied",
				});
			}

			const res = await handleSchemaFieldCreate(ctx.db, "posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: { targetCollection: "posts", multiple: true },
			});
			expect(res.success).toBe(false);

			// No orphan field row from the failed attempt.
			const field = await registry.getField("posts", "related");
			expect(field).toBeNull();
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("rolls back the just-created relation when field creation fails after it (atomicity)", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });

			// "id" is a reserved field slug — registry.createField rejects it
			// *after* the relation for this attempt has already been created,
			// exercising rollback of the relation insert alongside the field.
			const res = await handleSchemaFieldCreate(ctx.db, "posts", {
				slug: "id",
				label: "Id",
				type: "reference",
				validation: { targetCollection: "posts", multiple: true },
			});
			expect(res.success).toBe(false);

			const relRepo = new RelationRepository(ctx.db);
			const relations = await relRepo.list();
			expect(relations.find((r) => r.name === "posts_id")).toBeUndefined();
		} finally {
			await teardownForDialect(ctx);
		}
	});
});
