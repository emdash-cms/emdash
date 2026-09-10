import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	handleRelationCreate,
	handleRelationGet,
	handleRelationList,
	handleRelationUpdate,
	handleRelationDelete,
} from "../../../src/api/handlers/relations.js";
import { handleSchemaCollectionDelete } from "../../../src/api/handlers/schema.js";
import { PATCH as patchRelation } from "../../../src/astro/routes/api/relations/[id]/index.js";
import {
	GET as listRelations,
	POST as createRelation,
} from "../../../src/astro/routes/api/relations/index.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

// setupForDialectWithCollections registers two collections: "post" and "page".
// Relation create validates that both collections exist, so the handler tests
// use those real slugs rather than fabricated names.
const baseInput = {
	slug: "manages",
	parentCollection: "post",
	childCollection: "post",
	parentLabel: "Manager",
	childLabel: "Direct report",
};

describeEachDialect("relations definition handlers", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});
	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(ctx);
	});

	it("create returns the new relation; get fetches it by id", async () => {
		const created = await handleRelationCreate(ctx.db, { ...baseInput });
		expect(created.success).toBe(true);
		if (!created.success) return;
		expect(created.data.relation.slug).toBe("manages");

		const fetched = await handleRelationGet(ctx.db, created.data.relation.id);
		expect(fetched.success).toBe(true);
		if (!fetched.success) return;
		// The read carries what deleting it would take; a fresh relation has
		// nothing bound and no links.
		expect(fetched.data.relation).toEqual({
			...created.data.relation,
			boundFields: [],
			linkCount: 0,
		});
	});

	it("get returns NOT_FOUND for an unknown id", async () => {
		const result = await handleRelationGet(ctx.db, "nope");
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("NOT_FOUND");
	});

	it("list returns relations ordered by slug, optionally scoped to a collection", async () => {
		await handleRelationCreate(ctx.db, {
			...baseInput,
			slug: "writes",
			parentCollection: "page",
			childCollection: "page",
		});
		await handleRelationCreate(ctx.db, { ...baseInput, slug: "manages" });

		const all = await handleRelationList(ctx.db);
		expect(all.success).toBe(true);
		if (!all.success) return;
		expect(all.data.relations.map((r) => r.slug)).toEqual(["manages", "writes"]);

		// The picker only offers relations this collection is on an end of.
		const forPost = await handleRelationList(ctx.db, { collection: "post" });
		if (!forPost.success) return;
		expect(forPost.data.relations.map((r) => r.slug)).toEqual(["manages"]);
	});

	it("update changes only labels; unknown id is NOT_FOUND", async () => {
		const created = await handleRelationCreate(ctx.db, { ...baseInput });
		if (!created.success) return;
		const updated = await handleRelationUpdate(ctx.db, created.data.relation.id, {
			parentLabel: "Lead",
		});
		expect(updated.success).toBe(true);
		if (!updated.success) return;
		expect(updated.data.relation.parentLabel).toBe("Lead");
		expect(updated.data.relation.slug).toBe("manages");

		const missing = await handleRelationUpdate(ctx.db, "nope", { parentLabel: "x" });
		expect(missing.success).toBe(false);
		if (missing.success) return;
		expect(missing.error.code).toBe("NOT_FOUND");
	});

	it("delete removes the relation; unknown id is NOT_FOUND", async () => {
		const created = await handleRelationCreate(ctx.db, { ...baseInput });
		if (!created.success) return;
		const del = await handleRelationDelete(ctx.db, created.data.relation.id);
		expect(del.success).toBe(true);
		expect((await handleRelationGet(ctx.db, created.data.relation.id)).success).toBe(false);

		const missing = await handleRelationDelete(ctx.db, "nope");
		expect(missing.success).toBe(false);
		if (missing.success) return;
		expect(missing.error.code).toBe("NOT_FOUND");
	});

	it("create against a non-existent collection is COLLECTION_NOT_FOUND", async () => {
		const result = await handleRelationCreate(ctx.db, { ...baseInput, parentCollection: "ghost" });
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("COLLECTION_NOT_FOUND");
	});

	it("a duplicate slug is CONFLICT, not a 500-shaped *_ERROR", async () => {
		const first = await handleRelationCreate(ctx.db, { ...baseInput });
		expect(first.success).toBe(true);
		const second = await handleRelationCreate(ctx.db, { ...baseInput });
		expect(second.success).toBe(false);
		if (second.success) return;
		expect(second.error.code).toBe("CONFLICT");
	});

	it("delete takes the fields that view the relation with it", async () => {
		const created = await handleRelationCreate(ctx.db, { ...baseInput });
		if (!created.success) return;

		// Built through the registry rather than the field handler: binding a
		// field to a relation is the next PR's work, and the cascade under test
		// only cares that the field row names the relation.
		await new SchemaRegistry(ctx.db).createField("post", {
			slug: "manager",
			label: "Manager",
			type: "reference",
			validation: { relation: "manages", relationSide: "parent", targetCollection: "post" },
		});

		const del = await handleRelationDelete(ctx.db, created.data.relation.id);
		expect(del.success, JSON.stringify(del)).toBe(true);
		if (!del.success) return;
		// A field left pointing at a deleted relation could never be written
		// through, so the relation cannot outlive its views.
		expect(del.data.deletedFields).toEqual(["post.manager"]);

		const fields = await ctx.db
			.selectFrom("_emdash_fields")
			.select("slug")
			.where("slug", "=", "manager")
			.execute();
		expect(fields).toHaveLength(0);
	});

	it("reports the fields and links a delete would take", async () => {
		const created = await handleRelationCreate(ctx.db, { ...baseInput });
		if (!created.success) return;
		const relation = created.data.relation;

		await new SchemaRegistry(ctx.db).createField("post", {
			slug: "manager",
			label: "Manager",
			type: "reference",
			validation: { relation: "manages", relationSide: "child", targetCollection: "post" },
		});
		await new RelationRepository(ctx.db).addReference(relation.id, "parent-a", "child-b");

		const fetched = await handleRelationGet(ctx.db, relation.id);
		expect(fetched.success).toBe(true);
		if (!fetched.success) return;
		expect(fetched.data.relation.linkCount).toBe(1);
		expect(fetched.data.relation.boundFields).toEqual([
			{ collectionSlug: "post", fieldSlug: "manager", side: "child" },
		]);

		// The list carries the same figures, so the relations page can show them
		// per row without a read each.
		const listed = await handleRelationList(ctx.db);
		expect(listed.success).toBe(true);
		if (!listed.success) return;
		expect(listed.data.relations.find((r) => r.slug === "manages")).toMatchObject({
			linkCount: 1,
			boundFields: [{ collectionSlug: "post", fieldSlug: "manager", side: "child" }],
		});
	});

	it("deleting a collection takes its relations and the fields on the other end", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "author", label: "Authors", labelSingular: "Author" });

		const created = await handleRelationCreate(ctx.db, {
			slug: "post_author",
			parentCollection: "post",
			childCollection: "author",
			parentLabel: "Posts",
			childLabel: "Author",
		});
		if (!created.success) return;
		await new RelationRepository(ctx.db).addReference(created.data.relation.id, "pg", "cg");

		// The field lives on `post`, but the collection being deleted is `author`
		// — the far end. It has to go too, or it addresses a collection that no
		// longer exists.
		await registry.createField("post", {
			slug: "author",
			label: "Author",
			type: "reference",
			validation: { relation: "post_author", relationSide: "parent", targetCollection: "author" },
		});

		const deleted = await handleSchemaCollectionDelete(ctx.db, "author", { force: true });
		expect(deleted.success, JSON.stringify(deleted)).toBe(true);

		expect(await new RelationRepository(ctx.db).findBySlug("post_author")).toBeNull();
		expect(await registry.getField("post", "author")).toBeNull();
		const edges = await ctx.db.selectFrom("_emdash_content_references").selectAll().execute();
		expect(edges).toHaveLength(0);
	});
});

function userAt(role: RoleLevel) {
	return { id: "u", role };
}

function ctxFor(
	db: unknown,
	user: { id: string; role: RoleLevel },
	init?: { method?: string; body?: unknown },
): APIContext {
	const url = new URL("http://localhost/_emdash/api/relations");
	const request = new Request(url, {
		method: init?.method ?? "GET",
		headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
		body: init?.body ? JSON.stringify(init.body) : undefined,
	});
	return { params: {}, url, request, locals: { emdash: { db }, user } } as unknown as APIContext;
}

describeEachDialect("relations routes (auth)", (dialect) => {
	let ctx: DialectTestContext;
	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});
	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("GET list requires schema:read (EDITOR)", async () => {
		const denied = await listRelations(ctxFor(ctx.db, userAt(Role.AUTHOR as RoleLevel)));
		expect(denied.status).toBe(403);
		const ok = await listRelations(ctxFor(ctx.db, userAt(Role.EDITOR as RoleLevel)));
		expect(ok.status).toBe(200);
	});

	it("POST create requires schema:manage (ADMIN)", async () => {
		const body = { ...baseInput };
		const denied = await createRelation(
			ctxFor(ctx.db, userAt(Role.EDITOR as RoleLevel), { method: "POST", body }),
		);
		expect(denied.status).toBe(403);
		const ok = await createRelation(
			ctxFor(ctx.db, userAt(Role.ADMIN as RoleLevel), { method: "POST", body }),
		);
		expect(ok.status).toBe(201);
	});

	it("PATCH with an empty body is a 400, not a silent 200 no-op", async () => {
		const created = await handleRelationCreate(ctx.db, { ...baseInput });
		if (!created.success) return;
		const id = created.data.relation.id;

		const url = new URL(`http://localhost/_emdash/api/relations/${id}`);
		const request = new Request(url, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
			body: JSON.stringify({}),
		});
		const res = await patchRelation({
			params: { id },
			url,
			request,
			locals: { emdash: { db: ctx.db }, user: userAt(Role.ADMIN as RoleLevel) },
		} as unknown as APIContext);
		expect(res.status).toBe(400);
	});
});
