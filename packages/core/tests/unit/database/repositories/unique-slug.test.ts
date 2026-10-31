import { afterEach, beforeEach, expect, it } from "vitest";

import { ContentRepository } from "../../../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../../../src/database/repositories/taxonomy.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectName,
	type DialectTestContext,
} from "../../../utils/test-db.js";

describeEachDialect("generateUniqueSlug", (dialectName: DialectName) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialectName);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("takes the next numeric suffix of the base content slug in the locale", async () => {
		const repo = new ContentRepository(ctx.db);
		for (const slug of ["hello", "hello-2", "hello-x", "hello-3-4", "hello2-7", "hellothere-9"]) {
			await repo.create({ type: "post", slug, data: { title: "Hello" } });
		}
		await repo.create({ type: "post", slug: "hello-8", data: { title: "Hello" }, locale: "fr" });

		expect(await repo.generateUniqueSlug("post", "Hello", "en")).toBe("hello-3");
		expect(await repo.generateUniqueSlug("post", "Hello")).toBe("hello-9");
	});

	it("takes the next numeric suffix of the base term slug", async () => {
		const repo = new TaxonomyRepository(ctx.db);
		for (const slug of ["news", "news-5", "news-x", "newsroom-9"]) {
			await repo.create({ name: "category", slug, label: "News" });
		}

		expect(await repo.generateUniqueSlug("category", "News")).toBe("news-6");
	});
});
