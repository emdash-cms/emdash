import { sql } from "kysely";
import { expect, it } from "vitest";

import {
	handleSchemaFieldCreate,
	handleSchemaFieldDelete,
	handleSchemaFieldUpdate,
} from "../../../src/api/handlers/schema.js";
import { columnExists } from "../../../src/database/dialect-helpers.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { describeEachDialect, setupForDialect, teardownForDialect } from "../../utils/test-db.js";
import type { DialectTestContext } from "../../utils/test-db.js";

describeEachDialect("reference field lifecycle", (dialect) => {
	let ctx: DialectTestContext;

	it("creates a relation def when a reference field is created and stores its slug on the field", async () => {
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
			const rel = relations.find((r) => r.slug === "posts_related");
			expect(rel).toBeTruthy();
			expect(rel?.parentCollection).toBe("posts");
			expect(rel?.childCollection).toBe("posts");
			if (res.success) {
				expect(res.data.item.validation?.relation).toBe(rel?.slug);
				expect(res.data.item.validation?.targetCollection).toBe("posts");
			}
		} finally {
			await teardownForDialect(ctx);
		}
	});

	/** A collection with one reference field, plus one edge under its relation. */
	async function seedFieldWithEdge() {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });

		const created = await handleSchemaFieldCreate(ctx.db, "posts", {
			slug: "related",
			label: "Related",
			type: "reference",
			validation: { targetCollection: "posts", multiple: true },
		});
		if (!created.success) throw new Error("field create failed");

		const relRepo = new RelationRepository(ctx.db);
		const relation = await relRepo.findBySlug("posts_related");
		if (!relation) throw new Error("relation not created");
		await relRepo.addReference(relation.id, "parent-group-x", "child-group-y");

		return { registry, relRepo, relation };
	}

	function edgesFor(relationId: string) {
		return ctx.db
			.selectFrom("_emdash_content_references")
			.selectAll()
			.where("relation_id", "=", relationId)
			.execute();
	}

	it("keeps the relation and its edges when a reference field is deleted on its own", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const { registry, relRepo, relation } = await seedFieldWithEdge();

			const del = await handleSchemaFieldDelete(ctx.db, "posts", "related");
			expect(del.success).toBe(true);

			// The edges are content. Losing the field must not take them, so the
			// relation survives with no bound field until someone deletes it.
			expect(await relRepo.findBySlug("posts_related")).toBeTruthy();
			expect(await edgesFor(relation.id)).toHaveLength(1);
			expect(await registry.getField("posts", "related")).toBeNull();
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("deletes the relation and its edges when deleteRelation is set", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const { registry, relRepo, relation } = await seedFieldWithEdge();

			const del = await handleSchemaFieldDelete(ctx.db, "posts", "related", {
				deleteRelation: true,
			});
			expect(del.success).toBe(true);

			expect(await relRepo.findBySlug("posts_related")).toBeNull();
			expect(await edgesFor(relation.id)).toHaveLength(0);
			expect(await registry.getField("posts", "related")).toBeNull();
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("deleteRelation takes the field bound to the relation's other side", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const { registry, relRepo } = await seedFieldWithEdge();
			const relation = await relRepo.findBySlug("posts_related");
			if (!relation) return;

			// A second field views the same relation from the child end. Deleting
			// either one with the relation has to take the other with it, or it
			// would be left pointing at a relation that no longer exists.
			await registry.createField("posts", {
				slug: "referenced_by",
				label: "Referenced by",
				type: "reference",
				validation: {
					relation: relation.slug,
					relationSide: "child",
					targetCollection: "posts",
				},
			});

			const del = await handleSchemaFieldDelete(ctx.db, "posts", "related", {
				deleteRelation: true,
			});
			expect(del.success).toBe(true);

			expect(await registry.getField("posts", "related")).toBeNull();
			expect(await registry.getField("posts", "referenced_by")).toBeNull();
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("drops the column of a reference field that predates storage-less references", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			// Reference fields used to be column-backed. Create one as `string` so
			// the column DDL runs, then relabel it to reproduce that row exactly.
			await registry.createField("posts", { slug: "related", label: "Related", type: "string" });
			await sql`UPDATE _emdash_fields SET type = 'reference' WHERE slug = 'related'`.execute(
				ctx.db,
			);

			await registry.deleteField("posts", "related");

			expect(await columnExists(ctx.db, "ec_posts", "related")).toBe(false);
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("leaves no column behind when a storage-less reference field is deleted", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			await handleSchemaFieldCreate(ctx.db, "posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: { targetCollection: "posts", multiple: true },
			});

			await registry.deleteField("posts", "related");

			expect(await columnExists(ctx.db, "ec_posts", "related")).toBe(false);
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

	it("rejects creating a reference field whose target collection does not exist", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });

			const res = await handleSchemaFieldCreate(ctx.db, "posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: { targetCollection: "ghosts", multiple: true },
			});

			expect(res.success).toBe(false);
			if (!res.success) expect(res.error.code).toBe("COLLECTION_NOT_FOUND");

			// The transaction rolls back, so neither the field nor its relation persists.
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
			const relationSlug = created.data.item.validation?.relation;
			expect(relationSlug).toBeTruthy();
			if (!relationSlug) return;

			const updated = await handleSchemaFieldUpdate(ctx.db, "posts", "related", {
				label: "Related posts",
			});
			expect(updated.success).toBe(true);

			const relRepo = new RelationRepository(ctx.db);
			expect((await relRepo.findBySlug(relationSlug))?.childLabel).toBe("Related posts");
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
			const relationSlug = created.data.item.validation?.relation;
			expect(relationSlug).toBeTruthy();
			if (!relationSlug) return;

			const updated = await handleSchemaFieldUpdate(ctx.db, "posts", "related", {
				label: "Related posts",
				validation: null,
			});
			expect(updated.success).toBe(true);

			const field = await registry.getField("posts", "related");
			expect(field?.validation?.relation).toBe(relationSlug);
			expect(field?.validation?.targetCollection).toBe("posts");

			const relRepo = new RelationRepository(ctx.db);
			const relations = await relRepo.list();
			expect(relations.find((r) => r.slug === "posts_related")).toBeTruthy();
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
			const relationSlug = created.data.item.validation?.relation;
			expect(relationSlug).toBeTruthy();
			if (!relationSlug) return;

			const updated = await handleSchemaFieldUpdate(ctx.db, "posts", "related", {
				validation: { multiple: false },
			});
			expect(updated.success).toBe(true);

			const field = await registry.getField("posts", "related");
			expect(field?.validation?.relation).toBe(relationSlug);
			expect(field?.validation?.targetCollection).toBe("posts");
			expect(field?.validation?.multiple).toBe(false);

			const relRepo = new RelationRepository(ctx.db);
			const relations = await relRepo.list();
			expect(relations.find((r) => r.slug === "posts_related")).toBeTruthy();
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

	it("leaves no orphan field row when the relation slug cannot be allocated", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });

			// Occupy every name the suffix-retry loop would try (base + _2.._5)
			// so relation allocation is forced to exhaust and fail.
			const relRepo = new RelationRepository(ctx.db);
			const slugs = [
				"posts_related",
				"posts_related_2",
				"posts_related_3",
				"posts_related_4",
				"posts_related_5",
			];
			for (const slug of slugs) {
				await relRepo.create({
					slug,
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
			expect(relations.find((r) => r.slug === "posts_id")).toBeUndefined();
		} finally {
			await teardownForDialect(ctx);
		}
	});
	/** Two collections and one relation between them, bound to no field yet. */
	async function seedUnboundRelation() {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createCollection({ slug: "authors", label: "Authors", labelSingular: "Author" });

		const relation = await new RelationRepository(ctx.db).create({
			slug: "posts_authors",
			parentCollection: "posts",
			childCollection: "authors",
			parentLabel: "Posts",
			childLabel: "Authors",
			maxChildrenPerParent: 1,
		});
		return { registry, relation };
	}

	it("binds a new field to an existing relation instead of creating one", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const { relation } = await seedUnboundRelation();

			const res = await handleSchemaFieldCreate(ctx.db, "posts", {
				slug: "author",
				label: "Author",
				type: "reference",
				validation: { relation: "posts_authors" },
			});

			expect(res.success).toBe(true);
			if (res.success) {
				expect(res.data.item.validation?.relation).toBe("posts_authors");
				expect(res.data.item.validation?.relationSide).toBe("parent");
				expect(res.data.item.validation?.targetCollection).toBe("authors");
			}

			// The relation it bound to is the only one: binding must not create a
			// second relation alongside the one it was given.
			const relations = await new RelationRepository(ctx.db).list();
			expect(relations.map((r) => r.id)).toEqual([relation.id]);
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("derives the child side from the end that matches, and points the field back at the parent", async () => {
		ctx = await setupForDialect(dialect);
		try {
			await seedUnboundRelation();

			const res = await handleSchemaFieldCreate(ctx.db, "authors", {
				slug: "posts",
				label: "Posts",
				type: "reference",
				validation: { relation: "posts_authors" },
			});

			expect(res.success).toBe(true);
			if (res.success) {
				expect(res.data.item.validation?.relationSide).toBe("child");
				expect(res.data.item.validation?.targetCollection).toBe("posts");
			}
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("takes the requested side on a self-referential relation", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			await new RelationRepository(ctx.db).create({
				slug: "posts_related",
				parentCollection: "posts",
				childCollection: "posts",
				parentLabel: "Posts",
				childLabel: "Related posts",
			});

			const res = await handleSchemaFieldCreate(ctx.db, "posts", {
				slug: "referenced_by",
				label: "Referenced by",
				type: "reference",
				validation: { relation: "posts_related", relationSide: "child" },
			});

			expect(res.success).toBe(true);
			if (res.success) {
				expect(res.data.item.validation?.relationSide).toBe("child");
				expect(res.data.item.validation?.targetCollection).toBe("posts");
			}
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("refuses a second field on the same end of a relation", async () => {
		ctx = await setupForDialect(dialect);
		try {
			await seedUnboundRelation();

			const first = await handleSchemaFieldCreate(ctx.db, "posts", {
				slug: "author",
				label: "Author",
				type: "reference",
				validation: { relation: "posts_authors" },
			});
			expect(first.success).toBe(true);

			const second = await handleSchemaFieldCreate(ctx.db, "posts", {
				slug: "co_author",
				label: "Co-author",
				type: "reference",
				validation: { relation: "posts_authors" },
			});

			expect(second.success).toBe(false);
			if (!second.success) expect(second.error.code).toBe("CONFLICT");

			// The refused field leaves no row behind.
			expect(await new SchemaRegistry(ctx.db).getField("posts", "co_author")).toBeNull();
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("allows the opposite end of a relation that is already bound once", async () => {
		ctx = await setupForDialect(dialect);
		try {
			await seedUnboundRelation();

			await handleSchemaFieldCreate(ctx.db, "posts", {
				slug: "author",
				label: "Author",
				type: "reference",
				validation: { relation: "posts_authors" },
			});
			const inverse = await handleSchemaFieldCreate(ctx.db, "authors", {
				slug: "posts",
				label: "Posts",
				type: "reference",
				validation: { relation: "posts_authors" },
			});

			expect(inverse.success).toBe(true);
			if (inverse.success) expect(inverse.data.item.validation?.relationSide).toBe("child");
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("refuses a relation that does not touch the collection", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const { registry } = await seedUnboundRelation();
			await registry.createCollection({ slug: "pages", label: "Pages", labelSingular: "Page" });

			const res = await handleSchemaFieldCreate(ctx.db, "pages", {
				slug: "author",
				label: "Author",
				type: "reference",
				validation: { relation: "posts_authors" },
			});

			expect(res.success).toBe(false);
			if (!res.success) expect(res.error.code).toBe("VALIDATION_ERROR");
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("refuses a side that contradicts the matching end", async () => {
		ctx = await setupForDialect(dialect);
		try {
			await seedUnboundRelation();

			const res = await handleSchemaFieldCreate(ctx.db, "posts", {
				slug: "author",
				label: "Author",
				type: "reference",
				validation: { relation: "posts_authors", relationSide: "child" },
			});

			expect(res.success).toBe(false);
			if (!res.success) expect(res.error.code).toBe("VALIDATION_ERROR");
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("reports a relation that does not exist", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });

			const res = await handleSchemaFieldCreate(ctx.db, "posts", {
				slug: "author",
				label: "Author",
				type: "reference",
				validation: { relation: "nope" },
			});

			expect(res.success).toBe(false);
			if (!res.success) expect(res.error.code).toBe("NOT_FOUND");
		} finally {
			await teardownForDialect(ctx);
		}
	});
});
