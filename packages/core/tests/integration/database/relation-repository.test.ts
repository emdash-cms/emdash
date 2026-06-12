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
		).rejects.toThrow();
	});

	it("findById returns null for an unknown id", async () => {
		expect(await repo.findById("nope")).toBeNull();
	});
});
