import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	handleReferenceChildrenGet,
	handleReferenceChildrenSet,
	handleReferenceParentsGet,
} from "../../../src/api/handlers/relations.js";
import {
	GET as getChildren,
	POST as setChildren,
} from "../../../src/astro/routes/api/content/[collection]/[id]/references/[relation]/children.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

function edgeCtx(
	db: unknown,
	params: { collection: string; id: string; relation: string },
	user: { id: string; role: RoleLevel },
	init?: { method?: string; body?: unknown },
): APIContext {
	const url = new URL(
		`http://localhost/_emdash/api/content/${params.collection}/${params.id}/references/${params.relation}/children`,
	);
	const request = new Request(url, {
		method: init?.method ?? "GET",
		headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
		body: init?.body ? JSON.stringify(init.body) : undefined,
	});
	return { params, url, request, locals: { emdash: { db }, user } } as unknown as APIContext;
}

// setupForDialectWithCollections registers two collections: "post" and "page".
describeEachDialect("reference children handlers", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});
	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function makeRelation() {
		// post (parent) -> page (child)
		const repo = new RelationRepository(ctx.db);
		return repo.create({
			name: "related_pages",
			parentCollection: "post",
			childCollection: "page",
			parentLabel: "Post",
			childLabel: "Related page",
		});
	}

	it("set then get returns resolved child entries in order", async () => {
		const rel = await makeRelation();
		const content = new ContentRepository(ctx.db);
		const parent = await content.create({ type: "post", slug: "p", data: { title: "P" } });
		const a = await content.create({ type: "page", slug: "a", data: { title: "A" } });
		const b = await content.create({ type: "page", slug: "b", data: { title: "B" } });

		const set = await handleReferenceChildrenSet(ctx.db, "post", parent.id, rel.id, [a.id, b.id]);
		expect(set.success).toBe(true);
		if (!set.success) return;
		expect(set.data.children.map((c) => c.slug)).toEqual(["a", "b"]);
		expect(set.data.children.map((c) => c.sortOrder)).toEqual([0, 1]);
		expect(set.data.children.every((c) => c.collection === "page")).toBe(true);

		const get = await handleReferenceChildrenGet(ctx.db, "post", parent.id, rel.id);
		if (!get.success) return;
		expect(get.data.children.map((c) => c.slug)).toEqual(["a", "b"]);
	});

	it("resolved children carry their actual locale", async () => {
		const rel = await makeRelation();
		const content = new ContentRepository(ctx.db);
		const parent = await content.create({ type: "post", slug: "p", data: { title: "P" } });
		const a = await content.create({ type: "page", slug: "a", data: { title: "A" } });

		const set = await handleReferenceChildrenSet(ctx.db, "post", parent.id, rel.id, [a.id]);
		if (!set.success) return;
		expect(set.data.children[0]?.locale).toBe("en");
	});

	it("children GET paginates with a cursor", async () => {
		const rel = await makeRelation();
		const content = new ContentRepository(ctx.db);
		const parent = await content.create({ type: "post", slug: "p", data: { title: "P" } });
		const a = await content.create({ type: "page", slug: "a", data: { title: "A" } });
		const b = await content.create({ type: "page", slug: "b", data: { title: "B" } });
		const c = await content.create({ type: "page", slug: "c", data: { title: "C" } });
		await handleReferenceChildrenSet(ctx.db, "post", parent.id, rel.id, [a.id, b.id, c.id]);

		const page1 = await handleReferenceChildrenGet(ctx.db, "post", parent.id, rel.id, { limit: 2 });
		if (!page1.success) return;
		expect(page1.data.children.map((ref) => ref.slug)).toEqual(["a", "b"]);
		expect(page1.data.nextCursor).toBeDefined();

		const page2 = await handleReferenceChildrenGet(ctx.db, "post", parent.id, rel.id, {
			limit: 2,
			cursor: page1.data.nextCursor,
		});
		if (!page2.success) return;
		expect(page2.data.children.map((ref) => ref.slug)).toEqual(["c"]);
		expect(page2.data.nextCursor).toBeUndefined();
	});

	it("parents GET paginates over an unbounded backlink set", async () => {
		const rel = await makeRelation();
		const content = new ContentRepository(ctx.db);
		const shared = await content.create({ type: "page", slug: "shared", data: { title: "S" } });
		// Three posts all reference the same page.
		for (const slug of ["p1", "p2", "p3"]) {
			const parent = await content.create({ type: "post", slug, data: { title: slug } });
			await handleReferenceChildrenSet(ctx.db, "post", parent.id, rel.id, [shared.id]);
		}

		const page1 = await handleReferenceParentsGet(ctx.db, "page", shared.id, rel.id, { limit: 2 });
		if (!page1.success) return;
		expect(page1.data.parents).toHaveLength(2);
		expect(page1.data.nextCursor).toBeDefined();

		const page2 = await handleReferenceParentsGet(ctx.db, "page", shared.id, rel.id, {
			limit: 2,
			cursor: page1.data.nextCursor,
		});
		if (!page2.success) return;
		expect(page2.data.parents).toHaveLength(1);
		expect(page2.data.nextCursor).toBeUndefined();
	});

	it("an invalid pagination cursor is INVALID_CURSOR", async () => {
		const rel = await makeRelation();
		const content = new ContentRepository(ctx.db);
		const parent = await content.create({ type: "post", slug: "p", data: { title: "P" } });
		const result = await handleReferenceChildrenGet(ctx.db, "post", parent.id, rel.id, {
			cursor: "!!!not-a-cursor!!!",
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("INVALID_CURSOR");
	});

	it("unknown relation is NOT_FOUND", async () => {
		const content = new ContentRepository(ctx.db);
		const parent = await content.create({ type: "post", slug: "p", data: { title: "P" } });
		const result = await handleReferenceChildrenGet(ctx.db, "post", parent.id, "nope");
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("NOT_FOUND");
	});

	it("entry on the wrong side (child collection) is VALIDATION_ERROR", async () => {
		const rel = await makeRelation();
		const content = new ContentRepository(ctx.db);
		// A "page" entry is the child side, not the parent — children route rejects it.
		const page = await content.create({ type: "page", slug: "x", data: { title: "X" } });
		const result = await handleReferenceChildrenGet(ctx.db, "page", page.id, rel.id);
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("VALIDATION_ERROR");
	});

	it("a child whose collection != child_collection is rejected", async () => {
		const rel = await makeRelation();
		const content = new ContentRepository(ctx.db);
		const parent = await content.create({ type: "post", slug: "p", data: { title: "P" } });
		// Another post can't be a child (child_collection is "page").
		const otherPost = await content.create({ type: "post", slug: "q", data: { title: "Q" } });
		const result = await handleReferenceChildrenSet(ctx.db, "post", parent.id, rel.id, [
			otherPost.id,
		]);
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("NOT_FOUND");
	});

	it("parents is the backlink view from the child side", async () => {
		const rel = await makeRelation();
		const content = new ContentRepository(ctx.db);
		const parent = await content.create({ type: "post", slug: "p", data: { title: "P" } });
		const child = await content.create({ type: "page", slug: "c", data: { title: "C" } });
		await handleReferenceChildrenSet(ctx.db, "post", parent.id, rel.id, [child.id]);

		const result = await handleReferenceParentsGet(ctx.db, "page", child.id, rel.id);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.parents.map((p) => p.slug)).toEqual(["p"]);
		expect(result.data.parents.every((p) => p.collection === "post")).toBe(true);
	});

	it("parents rejects an entry on the parent side", async () => {
		const rel = await makeRelation();
		const content = new ContentRepository(ctx.db);
		const parent = await content.create({ type: "post", slug: "p", data: { title: "P" } });
		const result = await handleReferenceParentsGet(ctx.db, "post", parent.id, rel.id);
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("VALIDATION_ERROR");
	});
});

describeEachDialect("reference children route (auth + ownership)", (dialect) => {
	let ctx: DialectTestContext;
	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});
	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("GET requires content:read; POST gates on parent ownership", async () => {
		const repo = new RelationRepository(ctx.db);
		const rel = await repo.create({
			name: "related_pages",
			parentCollection: "post",
			childCollection: "page",
			parentLabel: "Post",
			childLabel: "Related page",
		});
		const content = new ContentRepository(ctx.db);
		const parent = await content.create({
			type: "post",
			slug: "p",
			data: { title: "P" },
			authorId: "author-1",
		});
		const child = await content.create({ type: "page", slug: "c", data: { title: "C" } });
		const params = { collection: "post", id: parent.id, relation: rel.id };

		// A different AUTHOR cannot edit author-1's content.
		const denied = await setChildren(
			edgeCtx(
				ctx.db,
				params,
				{ id: "author-2", role: Role.AUTHOR as RoleLevel },
				{
					method: "POST",
					body: { childIds: [child.id] },
				},
			),
		);
		expect(denied.status).toBe(403);

		// The owner can.
		const ok = await setChildren(
			edgeCtx(
				ctx.db,
				params,
				{ id: "author-1", role: Role.AUTHOR as RoleLevel },
				{
					method: "POST",
					body: { childIds: [child.id] },
				},
			),
		);
		expect(ok.status).toBe(200);

		// Anyone with content:read can GET.
		const read = await getChildren(
			edgeCtx(ctx.db, params, { id: "sub", role: Role.SUBSCRIBER as RoleLevel }),
		);
		expect(read.status).toBe(200);
	});

	it("POST gates the edit permission before the existence lookup (no oracle)", async () => {
		const repo = new RelationRepository(ctx.db);
		const rel = await repo.create({
			name: "related_pages",
			parentCollection: "post",
			childCollection: "page",
			parentLabel: "Post",
			childLabel: "Related page",
		});
		// A SUBSCRIBER has no edit permission. Whether the parent id exists or not,
		// they must get 403 — never a 404 that would reveal which ids are real.
		const fake = edgeCtx(
			ctx.db,
			{ collection: "post", id: "does-not-exist", relation: rel.id },
			{ id: "sub", role: Role.SUBSCRIBER as RoleLevel },
			{ method: "POST", body: { childIds: [] } },
		);
		const res = await setChildren(fake);
		expect(res.status).toBe(403);
	});
});
