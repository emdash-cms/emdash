import { afterEach, beforeEach, expect, it } from "vitest";

import { handleContentCreate, handleContentList } from "../../../src/api/handlers/content.js";
import { handleTaxonomyCreate } from "../../../src/api/handlers/taxonomies.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("content list term filters", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createCollection({ slug: "pages", label: "Pages", labelSingular: "Page" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

		for (const [name, collections] of [
			["topics", ["posts"]],
			["places", ["posts"]],
			["genres", ["pages"]],
		] as const) {
			const created = await handleTaxonomyCreate(ctx.db, {
				name,
				label: name,
				collections: [...collections],
			});
			if (!created.success) throw new Error(`taxonomy ${name} failed`);
		}

		const taxonomies = new TaxonomyRepository(ctx.db);
		const rodeo = await taxonomies.create({ name: "topics", slug: "rodeo", label: "Rodeo" });
		const polo = await taxonomies.create({ name: "topics", slug: "polo", label: "Polo" });
		const kentucky = await taxonomies.create({
			name: "places",
			slug: "kentucky",
			label: "Kentucky",
		});
		for (const [slug, groups] of [
			// Carries both picked topics, so it must still be listed once.
			["rodeo-post", [rodeo.translationGroup!, polo.translationGroup!, kentucky.translationGroup!]],
			["polo-post", [polo.translationGroup!]],
			["plain-post", []],
		] as const) {
			const created = await handleContentCreate(ctx.db, "posts", {
				slug,
				data: { title: slug },
			});
			if (!created.success) throw new Error(`seed ${slug} failed`);
			await taxonomies.attachGroupsToEntry("posts", created.data!.item.id, [...groups]);
		}
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("filters the items and the total", async () => {
		const result = await handleContentList(ctx.db, "posts", {
			termFilters: { topics: ["rodeo"] },
		});

		expect(result.success).toBe(true);
		expect(result.data!.items.map((item) => item.slug)).toEqual(["rodeo-post"]);
		expect(result.data!.total).toBe(1);
	});

	it("ORs within a taxonomy and ANDs across taxonomies, one row per entry", async () => {
		const result = await handleContentList(ctx.db, "posts", {
			termFilters: { topics: ["rodeo", "polo"], places: ["kentucky"] },
		});

		expect(result.success).toBe(true);
		expect(result.data!.items.map((item) => item.slug)).toEqual(["rodeo-post"]);
		expect(result.data!.total).toBe(1);
	});

	it("binds many slugs without running out of parameters", async () => {
		const slugs = [
			...Array.from({ length: 150 }, (_, index) => `missing-${index}`),
			"rodeo",
			"polo",
		];

		const result = await handleContentList(ctx.db, "posts", {
			termFilters: { topics: slugs },
			bylines: Array.from({ length: 25 }, (_, index) => `byline-${index}`),
			includeInferredBylines: true,
		});

		expect(result.success).toBe(true);
		expect(result.data!.total).toBe(0);

		const withoutBylines = await handleContentList(ctx.db, "posts", {
			termFilters: { topics: slugs },
		});
		expect(withoutBylines.data!.items.map((item) => item.slug).toSorted()).toEqual([
			"polo-post",
			"rodeo-post",
		]);
	});

	it("rejects a taxonomy that is not applied to the collection", async () => {
		const result = await handleContentList(ctx.db, "posts", {
			termFilters: { genres: ["drama"] },
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatchObject({
			code: "VALIDATION_ERROR",
			message: "Taxonomy not applied to posts: genres",
		});
	});

	it("rejects a taxonomy that does not exist", async () => {
		const result = await handleContentList(ctx.db, "posts", {
			termFilters: { topics: ["rodeo"], nosuch: ["x"] },
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatchObject({
			code: "VALIDATION_ERROR",
			message: "Taxonomy not applied to posts: nosuch",
		});
	});
});
