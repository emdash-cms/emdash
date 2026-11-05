import { afterEach, beforeEach, expect, it } from "vitest";

import { ContentRepository } from "../../../../src/database/repositories/content.js";
import type { DialectTestContext } from "../../../utils/test-db.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
} from "../../../utils/test-db.js";

describeEachDialect("ContentRepository.generateUniqueSlug", (dialect) => {
	let ctx: DialectTestContext;
	let repository: ContentRepository;
	let insertBatch = 0;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		repository = new ContentRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function insertSlugs(
		slugs: readonly string[],
		options: { locale?: string; deletedAt?: string } = {},
	): Promise<void> {
		const batch = insertBatch++;
		await ctx.db
			.insertInto("ec_post")
			.values(
				slugs.map((slug, index) => ({
					id: `${options.locale ?? "en"}-${batch}-${index}`,
					slug,
					locale: options.locale ?? "en",
					deleted_at: options.deletedAt ?? null,
				})),
			)
			.execute();
	}

	it("returns a free slug, and returns the normalized fallback for empty input", async () => {
		expect(await repository.generateUniqueSlug("post", "A free title")).toBe("a-free-title");
		expect(await repository.generateUniqueSlug("post", "")).toMatch(/^untitled-[a-z0-9]+$/);
	});

	it("uses the highest numeric suffix for long bases and reserves trashed slugs", async () => {
		const base = "this-is-a-label-that-is-comfortably-over-fifty-characters-long";
		await insertSlugs([
			base,
			`${base}-1`,
			`${base}-3`,
			`${base}-10`,
			`${base}-not-a-number`,
			`${base}-1x`,
			`${base}ball-99`,
		]);
		await insertSlugs([`${base}-11`], { deletedAt: "2025-01-01T00:00:00.000Z" });

		expect(await repository.generateUniqueSlug("post", base)).toBe(`${base}-12`);
	});

	it("scopes collisions to the requested locale, while unscoped lookup sees every locale", async () => {
		const base = "same-long-title-that-is-over-fifty-characters-for-testing";
		await insertSlugs([base, `${base}-2`], { locale: "en" });
		await insertSlugs([base, `${base}-4`], { locale: "fr" });
		await insertSlugs([`${base}-99`], { locale: "de" });

		expect(await repository.generateUniqueSlug("post", base, "fr")).toBe(`${base}-5`);
		expect(await repository.generateUniqueSlug("post", base)).toBe(`${base}-100`);
	});

	it("preserves Unicode bases, including supplementary-plane characters", async () => {
		const base = "𐐀 𐐁 title";
		const slug = await repository.generateUniqueSlug("post", base);
		expect(slug).toBe("𐐨-𐐩-title");
		await insertSlugs([slug!]);
		expect(await repository.generateUniqueSlug("post", base)).toBe(`${slug}-1`);
	});
});
