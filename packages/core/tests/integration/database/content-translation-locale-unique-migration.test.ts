import { afterEach, beforeEach, expect, it } from "vitest";

import * as migration080 from "../../../src/database/migrations/080_content_translation_locale_unique.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("content translation locale uniqueness migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		await migration080.down(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("splits existing duplicate locales, preserves terms, and is retry-safe", async () => {
		const content = new ContentRepository(ctx.db);
		const taxonomies = new TaxonomyRepository(ctx.db);
		const source = await content.create({
			type: "post",
			slug: "source",
			locale: "en",
			data: { title: "Source" },
		});
		const term = await taxonomies.create({ name: "tags", slug: "news", label: "News" });
		await taxonomies.setTermsForEntry("post", source.id, "tags", [term.id]);

		await ctx.db
			.insertInto("ec_post")
			.values({
				id: "duplicate-en",
				slug: "duplicate",
				status: "draft",
				title: "Duplicate",
				author_id: null,
				primary_byline_id: null,
				created_at: "2099-01-01T00:00:00.000Z",
				updated_at: "2099-01-01T00:00:00.000Z",
				published_at: null,
				scheduled_at: null,
				deleted_at: null,
				version: 1,
				live_revision_id: null,
				draft_revision_id: null,
				locale: "EN",
				translation_group: source.translationGroup,
			})
			.execute();

		await migration080.up(ctx.db);
		await migration080.up(ctx.db);

		await expect(content.findById("post", source.id)).resolves.toMatchObject({
			translationGroup: source.translationGroup,
		});
		await expect(content.findById("post", "duplicate-en")).resolves.toMatchObject({
			translationGroup: "duplicate-en",
		});
		await expect(
			taxonomies.getTermsForEntry("post", "duplicate-en", "tags", "en"),
		).resolves.toEqual([expect.objectContaining({ slug: "news" })]);
		await expect(
			content.create({
				type: "post",
				slug: "second-duplicate",
				locale: "en",
				translationOf: source.id,
				data: { title: "Second duplicate" },
			}),
		).rejects.toThrow();
	});
});
