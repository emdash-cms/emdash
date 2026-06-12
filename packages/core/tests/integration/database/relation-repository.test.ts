import { afterEach, beforeEach, expect, it } from "vitest";
import { ulid } from "ulidx";

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
		name: "manages",
		parentCollection: "employees",
		childCollection: "employees",
		parentLabel: "Manager",
		childLabel: "Direct report",
	};

	it("create mints an anchor row (translation_group = id, default locale)", async () => {
		const rel = await repo.create({ ...baseInput });
		expect(rel.id).toBeTruthy();
		expect(rel.translationGroup).toBe(rel.id);
		expect(rel.locale).toBe("en");
		expect(rel.name).toBe("manages");
		expect(rel.parentCollection).toBe("employees");
		expect(rel.childCollection).toBe("employees");

		const fetched = await repo.findById(rel.id);
		expect(fetched).toEqual(rel);
	});

	it("create with translationOf joins the group and inherits structural fields", async () => {
		const anchor = await repo.create({ ...baseInput });
		const fr = await repo.create({
			name: "ignored-name",
			parentCollection: "ignored",
			childCollection: "ignored",
			parentLabel: "Responsable",
			childLabel: "Subordonné",
			locale: "fr",
			translationOf: anchor.id,
		});

		expect(fr.translationGroup).toBe(anchor.translationGroup);
		expect(fr.locale).toBe("fr");
		expect(fr.name).toBe("manages");
		expect(fr.parentCollection).toBe("employees");
		expect(fr.childCollection).toBe("employees");
		expect(fr.parentLabel).toBe("Responsable");
		expect(fr.childLabel).toBe("Subordonné");
	});

	it("create with a missing translationOf source throws", async () => {
		await expect(
			repo.create({ ...baseInput, locale: "fr", translationOf: "does-not-exist" }),
		).rejects.toThrow("Source relation for translation not found");
	});

	it("findById returns null for an unknown id", async () => {
		expect(await repo.findById("nope")).toBeNull();
	});

	it("findByName filters by locale, and resolves deterministically without one", async () => {
		const anchor = await repo.create({ ...baseInput });
		await repo.create({
			...baseInput,
			locale: "fr",
			parentLabel: "Responsable",
			childLabel: "Subordonné",
			translationOf: anchor.id,
		});

		const fr = await repo.findByName("manages", "fr");
		expect(fr?.locale).toBe("fr");

		const any = await repo.findByName("manages");
		expect(any?.locale).toBe("en"); // lowest locale code wins deterministically

		expect(await repo.findByName("missing")).toBeNull();
	});

	it("findTranslations returns every locale sibling, ordered by locale", async () => {
		const anchor = await repo.create({ ...baseInput });
		await repo.create({
			...baseInput,
			locale: "fr",
			parentLabel: "Responsable",
			childLabel: "Subordonné",
			translationOf: anchor.id,
		});

		const sibs = await repo.findTranslations(anchor.translationGroup);
		expect(sibs.map((r) => r.locale)).toEqual(["en", "fr"]);
	});

	it("list returns relations ordered by name then id, optionally filtered by locale", async () => {
		await repo.create({ ...baseInput, name: "writes", childCollection: "posts" });
		const manages = await repo.create({ ...baseInput, name: "manages" });
		await repo.create({
			...baseInput,
			locale: "fr",
			parentLabel: "Responsable",
			childLabel: "Subordonné",
			translationOf: manages.id,
		});

		const all = await repo.list();
		expect(all.map((r) => r.name)).toEqual(["manages", "manages", "writes"]);

		const enOnly = await repo.list("en");
		// The 'fr' row must be filtered out — assert the filter actually removes it.
		expect(enOnly.length).toBeLessThan(all.length);
		expect(enOnly.every((r) => r.locale === "en")).toBe(true);
	});

	it("findForCollection matches parent OR child collection", async () => {
		await repo.create({
			...baseInput,
			name: "writes",
			parentCollection: "authors",
			childCollection: "posts",
		});
		await repo.create({
			...baseInput,
			name: "tags_rel",
			parentCollection: "posts",
			childCollection: "tags",
		});

		const forPosts = await repo.findForCollection("posts");
		// Asserted in returned order to also verify the (name, id) ORDER BY.
		expect(forPosts.map((r) => r.name)).toEqual(["tags_rel", "writes"]);

		const forTags = await repo.findForCollection("tags");
		expect(forTags.map((r) => r.name)).toEqual(["tags_rel"]);
	});

	it("update changes only the localized labels (no-op on missing id)", async () => {
		const rel = await repo.create({ ...baseInput });
		const updated = await repo.update(rel.id, { parentLabel: "Lead", childLabel: "Report" });

		expect(updated?.parentLabel).toBe("Lead");
		expect(updated?.childLabel).toBe("Report");
		// Structural fields untouched.
		expect(updated?.name).toBe("manages");
		expect(updated?.parentCollection).toBe("employees");

		expect(await repo.update("missing", { parentLabel: "x" })).toBeNull();
	});

	it("delete of a non-last translation leaves edges intact", async () => {
		const anchor = await repo.create({ ...baseInput });
		const fr = await repo.create({
			...baseInput,
			locale: "fr",
			parentLabel: "Responsable",
			childLabel: "Subordonné",
			translationOf: anchor.id,
		});
		// Seed an edge directly (addReference arrives in Task 4).
		await ctx.db
			.insertInto("_emdash_content_references")
			.values({
				id: ulid(),
				relation_group: anchor.translationGroup,
				parent_group: "parentG",
				child_group: "childG",
				sort_order: 0,
			})
			.execute();

		expect(await repo.delete(fr.id)).toBe(true);
		// The 'en' anchor row must survive (only the 'fr' translation was deleted)...
		expect(await repo.findById(anchor.id)).not.toBeNull();
		// ...and so must its edges.
		const edges = await ctx.db
			.selectFrom("_emdash_content_references")
			.selectAll()
			.where("relation_group", "=", anchor.translationGroup)
			.execute();
		expect(edges).toHaveLength(1);
	});

	it("delete of the last translation purges edges for that relation group", async () => {
		const anchor = await repo.create({ ...baseInput });
		await ctx.db
			.insertInto("_emdash_content_references")
			.values({
				id: ulid(),
				relation_group: anchor.translationGroup,
				parent_group: "parentG",
				child_group: "childG",
				sort_order: 0,
			})
			.execute();

		expect(await repo.delete(anchor.id)).toBe(true);
		const edges = await ctx.db
			.selectFrom("_emdash_content_references")
			.selectAll()
			.where("relation_group", "=", anchor.translationGroup)
			.execute();
		expect(edges).toHaveLength(0);
		expect(await repo.findById(anchor.id)).toBeNull();
	});

	it("addReference appends by sort_order and dedupes on conflict", async () => {
		const rel = await repo.create({ ...baseInput });
		await repo.addReference(rel.id, "p1", "cA");
		await repo.addReference(rel.id, "p1", "cB");
		await repo.addReference(rel.id, "p1", "cA"); // duplicate — no-op

		const children = await repo.getChildren(rel.translationGroup, "p1");
		expect(children.map((c) => c.childGroup)).toEqual(["cA", "cB"]);
		expect(children.map((c) => c.sortOrder)).toEqual([0, 1]);
	});

	it("addReference accepts a relation id OR its group, and an explicit sortOrder", async () => {
		const rel = await repo.create({ ...baseInput });
		await repo.addReference(rel.translationGroup, "p1", "cA", 5);
		const children = await repo.getChildren(rel.translationGroup, "p1");
		expect(children).toEqual([
			{
				id: expect.any(String),
				relationGroup: rel.translationGroup,
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

		const parents = await repo.getParents(rel.translationGroup, "shared");
		expect(parents.map((p) => p.parentGroup).toSorted()).toEqual(["p1", "p2"]);

		await repo.removeReference(rel.id, "p1", "shared");
		const after = await repo.getParents(rel.translationGroup, "shared");
		expect(after.map((p) => p.parentGroup)).toEqual(["p2"]);
	});

	it("self-reference (same group as parent and child) is allowed", async () => {
		const rel = await repo.create({ ...baseInput });
		await repo.addReference(rel.id, "self", "self");
		const children = await repo.getChildren(rel.translationGroup, "self");
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

		let children = await repo.getChildren(rel.translationGroup, "p1");
		expect(children.map((c) => c.childGroup)).toEqual(["a", "b", "c"]);
		expect(children.map((c) => c.sortOrder)).toEqual([0, 1, 2]);

		// Reorder + drop 'a' + add 'd'.
		await repo.setChildren(rel.id, "p1", ["c", "b", "d"]);
		children = await repo.getChildren(rel.translationGroup, "p1");
		expect(children.map((c) => c.childGroup)).toEqual(["c", "b", "d"]);
		expect(children.map((c) => c.sortOrder)).toEqual([0, 1, 2]);
	});

	it("setChildren with an empty list clears the parent's children", async () => {
		const rel = await repo.create({ ...baseInput });
		await repo.setChildren(rel.id, "p1", ["a", "b"]);
		await repo.setChildren(rel.id, "p1", []);
		expect(await repo.getChildren(rel.translationGroup, "p1")).toEqual([]);
	});

	it("setChildren collapses duplicate childGroups (one edge per child)", async () => {
		const rel = await repo.create({ ...baseInput });
		await repo.setChildren(rel.id, "p1", ["a", "b", "a"]);
		const children = await repo.getChildren(rel.translationGroup, "p1");
		expect(children.map((c) => c.childGroup)).toEqual(["a", "b"]);
		expect(children.map((c) => c.sortOrder)).toEqual([0, 1]);
	});

	it("setChildren no-ops for an unknown relation", async () => {
		await expect(repo.setChildren("unknown-relation", "p1", ["a"])).resolves.toBeUndefined();
		expect(await repo.getChildren("unknown-relation", "p1")).toEqual([]);
	});

	it("clearReferencesForGroup removes edges where the group is parent OR child", async () => {
		const rel = await repo.create({ ...baseInput });
		await repo.addReference(rel.id, "X", "a"); // X as parent
		await repo.addReference(rel.id, "b", "X"); // X as child
		await repo.addReference(rel.id, "b", "c"); // unrelated

		const removed = await repo.clearReferencesForGroup("X");
		expect(removed).toBe(2);

		expect(await repo.getChildren(rel.translationGroup, "X")).toHaveLength(0);
		expect(await repo.getParents(rel.translationGroup, "X")).toHaveLength(0);
		expect(await repo.getChildren(rel.translationGroup, "b")).toHaveLength(1);
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
