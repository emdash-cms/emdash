import { afterEach, beforeEach, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("taxonomy assignments shared by content translations", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("reflects assignment changes across sibling locales with locale-correct terms", async () => {
		const content = new ContentRepository(ctx.db);
		const taxonomies = new TaxonomyRepository(ctx.db);
		const enPost = await content.create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			locale: "en",
		});
		const frPost = await content.create({
			type: "post",
			slug: "bonjour",
			data: { title: "Bonjour" },
			locale: "fr",
			translationOf: enPost.id,
		});
		const enNews = await taxonomies.create({
			name: "tags",
			slug: "news",
			label: "News",
			locale: "en",
		});
		const frNews = await taxonomies.create({
			name: "tags",
			slug: "actualites",
			label: "Actualités",
			locale: "fr",
			translationOf: enNews.id,
		});

		await taxonomies.setTermsForEntry("post", enPost.id, "tags", [enNews.id]);

		const frTerms = await taxonomies.getTermsForEntry("post", frPost.id, "tags", "fr");
		expect(frTerms.map((term) => term.id)).toEqual([frNews.id]);

		await taxonomies.setTermsForEntry("post", frPost.id, "tags", []);

		const enTerms = await taxonomies.getTermsForEntry("post", enPost.id, "tags", "en");
		expect(enTerms).toEqual([]);
	});
});
