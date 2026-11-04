import { ulid } from "ulidx";
import { afterEach, beforeEach, expect, it } from "vitest";

import { RelationRepository } from "../../../src/database/repositories/relation.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("RelationRepository", (dialect) => {
	let ctx: DialectTestContext;
	let repo: RelationRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect); // runs all migrations
		repo = new RelationRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	const baseInput = {
		slug: "manages",
		parentCollection: "employees",
		childCollection: "employees",
		parentLabel: "Manager",
		childLabel: "Direct report",
	};

	it("create stores the relation and reads it back by id", async () => {
		const rel = await repo.create({ ...baseInput });
		expect(rel.id).toBeTruthy();
		expect(rel.slug).toBe("manages");
		expect(rel.parentCollection).toBe("employees");
		expect(rel.childCollection).toBe("employees");
		expect(rel.parentLabel).toBe("Manager");

		const fetched = await repo.findById(rel.id);
		expect(fetched).toEqual(rel);
	});

	it("rejects a second relation with the same slug", async () => {
		await repo.create({ ...baseInput });
		// A slug identifies one relation outright — that is what lets an entry in
		// any locale resolve it without a locale to scope by.
		await expect(repo.create({ ...baseInput, parentCollection: "posts" })).rejects.toThrow();
	});

	it("findById returns null for an unknown id", async () => {
		expect(await repo.findById("nope")).toBeNull();
	});

	it("findBySlug resolves without a locale", async () => {
		const rel = await repo.create({ ...baseInput });

		expect((await repo.findBySlug("manages"))?.id).toBe(rel.id);
		expect(await repo.findBySlug("missing")).toBeNull();
	});

	it("list returns relations ordered by slug", async () => {
		await repo.create({ ...baseInput, slug: "writes", childCollection: "posts" });
		await repo.create({ ...baseInput, slug: "manages" });

		expect((await repo.list()).map((r) => r.slug)).toEqual(["manages", "writes"]);
	});

	it("findForCollection matches parent OR child collection", async () => {
		await repo.create({
			...baseInput,
			slug: "writes",
			parentCollection: "authors",
			childCollection: "posts",
		});
		await repo.create({
			...baseInput,
			slug: "tags_rel",
			parentCollection: "posts",
			childCollection: "tags",
		});

		const forPosts = await repo.findForCollection("posts");
		// Asserted in returned order to also verify the slug ORDER BY.
		expect(forPosts.map((r) => r.slug)).toEqual(["tags_rel", "writes"]);

		const forTags = await repo.findForCollection("tags");
		expect(forTags.map((r) => r.slug)).toEqual(["tags_rel"]);
	});

	it("update changes only the labels (no-op on missing id)", async () => {
		const rel = await repo.create({ ...baseInput });
		const updated = await repo.update(rel.id, { parentLabel: "Lead", childLabel: "Report" });

		expect(updated?.parentLabel).toBe("Lead");
		expect(updated?.childLabel).toBe("Report");
		// Structural fields untouched.
		expect(updated?.slug).toBe("manages");
		expect(updated?.parentCollection).toBe("employees");

		expect(await repo.update("missing", { parentLabel: "x" })).toBeNull();
	});

	it("defaults both role limits and both singular labels to unset", async () => {
		const rel = await repo.create({ ...baseInput });

		expect(rel.maxChildrenPerParent).toBeNull();
		expect(rel.maxParentsPerChild).toBeNull();
		expect(rel.parentLabelSingular).toBeNull();
		expect(rel.childLabelSingular).toBeNull();
	});

	it("stores each role's limit and singular label independently", async () => {
		const rel = await repo.create({
			...baseInput,
			parentLabelSingular: "Manager",
			childLabelSingular: "Direct report",
			maxChildrenPerParent: 5,
		});

		expect(rel.maxChildrenPerParent).toBe(5);
		expect(rel.maxParentsPerChild).toBeNull();
		expect(rel.parentLabelSingular).toBe("Manager");

		// One side's limit is settable without disturbing the other's.
		const updated = await repo.update(rel.id, { maxParentsPerChild: 1 });
		expect(updated?.maxParentsPerChild).toBe(1);
		expect(updated?.maxChildrenPerParent).toBe(5);
	});

	it("clears a role limit when set back to null", async () => {
		const rel = await repo.create({ ...baseInput, maxChildrenPerParent: 5 });

		// `undefined` means "leave alone", so `null` has to be the way to lift a
		// limit — otherwise a one-to-many relation could never become many-to-many.
		expect((await repo.update(rel.id, { maxChildrenPerParent: null }))?.maxChildrenPerParent).toBe(
			null,
		);
	});

	it("delete purges the relation's edges", async () => {
		const rel = await repo.create({ ...baseInput });
		await ctx.db
			.insertInto("_emdash_content_references")
			.values({
				id: ulid(),
				relation_id: rel.id,
				parent_group: "parentG",
				child_group: "childG",
				sort_order: 0,
			})
			.execute();

		expect(await repo.delete(rel.id)).toBe(true);
		const edges = await ctx.db
			.selectFrom("_emdash_content_references")
			.selectAll()
			.where("relation_id", "=", rel.id)
			.execute();
		expect(edges).toHaveLength(0);
		expect(await repo.findById(rel.id)).toBeNull();
	});

	it("addReference appends by sort_order and dedupes on conflict", async () => {
		const rel = await repo.create({ ...baseInput });
		await repo.addReference(rel.id, "p1", "cA");
		await repo.addReference(rel.id, "p1", "cB");
		await repo.addReference(rel.id, "p1", "cA"); // duplicate — no-op

		const children = await repo.getChildren(rel.id, "p1");
		expect(children.map((c) => c.childGroup)).toEqual(["cA", "cB"]);
		expect(children.map((c) => c.sortOrder)).toEqual([0, 1]);
	});

	it("addReference accepts a relation id OR its slug, and an explicit sortOrder", async () => {
		const rel = await repo.create({ ...baseInput });
		await repo.addReference(rel.id, "p1", "cA", 5);
		const children = await repo.getChildren(rel.id, "p1");
		expect(children).toEqual([
			{
				id: expect.any(String),
				relationId: rel.id,
				parentGroup: "p1",
				childGroup: "cA",
				sortOrder: 5,
			},
		]);
	});

	it("getParents is the backlink view; removeReference removes one edge", async () => {
		const rel = await repo.create({ ...baseInput });
		await repo.addReference(rel.id, "p1", "shared");
		await repo.addReference(rel.id, "p2", "shared");

		const parents = await repo.getParents(rel.id, "shared");
		expect(parents.map((p) => p.parentGroup).toSorted()).toEqual(["p1", "p2"]);

		await repo.removeReference(rel.id, "p1", "shared");
		const after = await repo.getParents(rel.id, "shared");
		expect(after.map((p) => p.parentGroup)).toEqual(["p2"]);
	});

	it("self-reference (same group as parent and child) is allowed", async () => {
		const rel = await repo.create({ ...baseInput });
		await repo.addReference(rel.id, "self", "self");
		const children = await repo.getChildren(rel.id, "self");
		expect(children.map((c) => c.childGroup)).toEqual(["self"]);
	});

	it("edge methods no-op for an unknown relation", async () => {
		await repo.addReference("unknown-relation", "p1", "cA");
		expect(await repo.getChildren("unknown-relation", "p1")).toEqual([]);
	});

	it("removeReference of a nonexistent edge is a no-op", async () => {
		const rel = await repo.create({ ...baseInput });
		await expect(repo.removeReference(rel.id, "p1", "never-added")).resolves.toBeUndefined();
	});

	it("setChildren replaces the set and assigns positional sort_order", async () => {
		const rel = await repo.create({ ...baseInput });
		await repo.setChildren(rel.id, "p1", ["a", "b", "c"]);

		let children = await repo.getChildren(rel.id, "p1");
		expect(children.map((c) => c.childGroup)).toEqual(["a", "b", "c"]);
		expect(children.map((c) => c.sortOrder)).toEqual([0, 1, 2]);

		// Reorder + drop 'a' + add 'd'.
		await repo.setChildren(rel.id, "p1", ["c", "b", "d"]);
		children = await repo.getChildren(rel.id, "p1");
		expect(children.map((c) => c.childGroup)).toEqual(["c", "b", "d"]);
		expect(children.map((c) => c.sortOrder)).toEqual([0, 1, 2]);
	});

	it("setChildren with an empty list clears the parent's children", async () => {
		const rel = await repo.create({ ...baseInput });
		await repo.setChildren(rel.id, "p1", ["a", "b"]);
		await repo.setChildren(rel.id, "p1", []);
		expect(await repo.getChildren(rel.id, "p1")).toEqual([]);
	});

	it("setChildren collapses duplicate childGroups (one edge per child)", async () => {
		const rel = await repo.create({ ...baseInput });
		await repo.setChildren(rel.id, "p1", ["a", "b", "a"]);
		const children = await repo.getChildren(rel.id, "p1");
		expect(children.map((c) => c.childGroup)).toEqual(["a", "b"]);
		expect(children.map((c) => c.sortOrder)).toEqual([0, 1]);
	});

	it("setChildren no-ops for an unknown relation", async () => {
		// Nothing was written, and nothing was refused by a limit either.
		await expect(repo.setChildren("unknown-relation", "p1", ["a"])).resolves.toEqual([]);
		expect(await repo.getChildren("unknown-relation", "p1")).toEqual([]);
	});

	it("setParents replaces the parents pointing at one child", async () => {
		const rel = await repo.create({ ...baseInput });
		await repo.setParents(rel.id, "c1", ["p1", "p2"]);

		// A child's parents have no order: `sort_order` positions children within
		// one parent and has no counterpart here, so `getParents` falls back to
		// link id, and two links written in the same millisecond carry ULIDs whose
		// order is not the write order. Assert the set.
		expect(
			(await repo.getParents(rel.id, "c1")).map((edge) => edge.parentGroup).toSorted(),
		).toEqual(["p1", "p2"]);

		await repo.setParents(rel.id, "c1", ["p2", "p3"]);
		expect(
			(await repo.getParents(rel.id, "c1")).map((edge) => edge.parentGroup).toSorted(),
		).toEqual(["p2", "p3"]);
	});

	it("setParents leaves the other children of a parent it drops", async () => {
		const rel = await repo.create({ ...baseInput });
		await repo.setChildren(rel.id, "p1", ["c1", "c2"]);

		await repo.setParents(rel.id, "c1", []);

		// Replace-all is scoped to (relation, child), so p1 keeps c2.
		expect((await repo.getChildren(rel.id, "p1")).map((edge) => edge.childGroup)).toEqual(["c2"]);
	});

	it("setParents appends at the end of each parent's existing children", async () => {
		const rel = await repo.create({ ...baseInput });
		await repo.setChildren(rel.id, "p1", ["c1", "c2"]);

		await repo.setParents(rel.id, "c3", ["p1"]);

		const children = await repo.getChildren(rel.id, "p1");
		expect(children.map((edge) => edge.childGroup)).toEqual(["c1", "c2", "c3"]);
		expect(children.map((edge) => edge.sortOrder)).toEqual([0, 1, 2]);
	});

	it("setParents collapses duplicates and no-ops for an unknown relation", async () => {
		const rel = await repo.create({ ...baseInput });
		await repo.setParents(rel.id, "c1", ["p1", "p1"]);
		expect(await repo.getParents(rel.id, "c1")).toHaveLength(1);

		await expect(repo.setParents("unknown-relation", "c1", ["p1"])).resolves.toEqual([]);
	});

	it("setParents leaves a kept parent's position among its children alone", async () => {
		const rel = await repo.create({ ...baseInput });
		await repo.setChildren(rel.id, "p1", ["c1", "c2", "c3"]);

		// Saving c1's own backlink field re-states the parent it already has.
		// `sort_order` belongs to p1's list, so c1 must not be moved to the end of it.
		await repo.setParents(rel.id, "c1", ["p1"]);

		const children = await repo.getChildren(rel.id, "p1");
		expect(children.map((edge) => edge.childGroup)).toEqual(["c1", "c2", "c3"]);
		expect(children.map((edge) => edge.sortOrder)).toEqual([0, 1, 2]);
	});

	it("setChildren keeps the previous selection when the far side refuses an addition", async () => {
		const rel = await repo.create({ ...baseInput, maxParentsPerChild: 1 });
		await repo.setChildren(rel.id, "p1", ["a", "b"]);
		// "x" has spent its one parent slot elsewhere.
		await repo.setChildren(rel.id, "p2", ["x"]);

		const rejected = await repo.setChildren(rel.id, "p1", ["x"]);

		expect(rejected).toEqual(["x"]);
		// The caller is told the save failed, so the save must not have happened.
		expect((await repo.getChildren(rel.id, "p1")).map((edge) => edge.childGroup)).toEqual([
			"a",
			"b",
		]);
	});

	it("setParents keeps the previous selection when the far side refuses an addition", async () => {
		const rel = await repo.create({ ...baseInput, maxChildrenPerParent: 1 });
		await repo.setParents(rel.id, "c1", ["p1"]);
		// "p2" has spent its one child slot elsewhere.
		await repo.setChildren(rel.id, "p2", ["other"]);

		const rejected = await repo.setParents(rel.id, "c1", ["p2"]);

		expect(rejected).toEqual(["p2"]);
		expect((await repo.getParents(rel.id, "c1")).map((edge) => edge.parentGroup)).toEqual(["p1"]);
	});

	it("setChildren under a far-side limit re-states an unchanged selection", async () => {
		const rel = await repo.create({ ...baseInput, maxParentsPerChild: 1 });
		await repo.setChildren(rel.id, "p1", ["a", "b"]);

		// Every child already holds its one parent slot — this parent's own. A
		// re-save must recognize them rather than refuse them as somebody else's.
		await expect(repo.setChildren(rel.id, "p1", ["a", "b"])).resolves.toEqual([]);
		expect((await repo.getChildren(rel.id, "p1")).map((edge) => edge.childGroup)).toEqual([
			"a",
			"b",
		]);
	});

	it("clearReferencesForGroup removes edges where the group is parent OR child", async () => {
		const rel = await repo.create({ ...baseInput });
		await repo.addReference(rel.id, "X", "a"); // X as parent
		await repo.addReference(rel.id, "b", "X"); // X as child
		await repo.addReference(rel.id, "b", "c"); // unrelated

		const removed = await repo.clearReferencesForGroup("X");
		expect(removed).toBe(2);

		expect(await repo.getChildren(rel.id, "X")).toHaveLength(0);
		expect(await repo.getParents(rel.id, "X")).toHaveLength(0);
		expect(await repo.getChildren(rel.id, "b")).toHaveLength(1);
	});

	it("clearReferencesForGroup purges the group's edges across every relation", async () => {
		const relA = await repo.create({ ...baseInput, slug: "rel_a" });
		const relB = await repo.create({ ...baseInput, slug: "rel_b" });
		// The same content group "X" participates in edges under two relations.
		await repo.addReference(relA.id, "X", "a");
		await repo.addReference(relB.id, "b", "X");

		const removed = await repo.clearReferencesForGroup("X");
		expect(removed).toBe(2);
		expect(await repo.getChildren(relA.id, "X")).toHaveLength(0);
		expect(await repo.getParents(relB.id, "X")).toHaveLength(0);
	});

	it("countChildren and countParents count edges", async () => {
		const rel = await repo.create({ ...baseInput });
		await repo.addReference(rel.id, "p1", "a");
		await repo.addReference(rel.id, "p1", "b");
		await repo.addReference(rel.id, "p2", "a");

		expect(await repo.countChildren(rel.id, "p1")).toBe(2);
		expect(await repo.countParents(rel.id, "a")).toBe(2);

		// Unknown relation resolves to no group → zero.
		expect(await repo.countChildren("unknown-relation", "p1")).toBe(0);
		expect(await repo.countParents("unknown-relation", "a")).toBe(0);
	});

	it("countChildrenForParents batches across more than SQL_BATCH_SIZE parents", async () => {
		const rel = await repo.create({ ...baseInput });
		const parents = Array.from({ length: 120 }, (_, i) => `p${i}`);
		for (const p of parents) await repo.addReference(rel.id, p, "child");

		const counts = await repo.countChildrenForParents(rel.id, parents);
		expect(counts.size).toBe(120);
		expect(counts.get("p0")).toBe(1);
		expect(counts.get("p119")).toBe(1);

		expect((await repo.countChildrenForParents(rel.id, [])).size).toBe(0);
	});
});
