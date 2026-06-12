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
});
