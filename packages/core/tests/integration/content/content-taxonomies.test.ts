/**
 * MCP + REST content create/update accept a `taxonomies` field that assigns
 * taxonomy terms in the same transaction (issue #953).
 *
 * Prior behaviour: `content_create` silently ignored the field and callers had
 * to make N follow-up REST calls to attach categories/tags. The regression
 * this suite guards is that the field now resolves term slugs in the entry's
 * locale, persists the assignments via `setTermsForEntry` (same path as the
 * `/terms/{taxonomy}` REST route), and reports validation errors rather than
 * silently dropping unknown terms.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { handleContentCreate, handleContentUpdate } from "../../../src/api/handlers/content.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

async function seedTerms(db: Kysely<Database>) {
	const taxRepo = new TaxonomyRepository(db);
	const cat = await taxRepo.create({
		name: "category",
		slug: "porady",
		label: "Porady",
		locale: "en",
	});
	const tagAi = await taxRepo.create({
		name: "tag",
		slug: "ai",
		label: "AI",
		locale: "en",
	});
	const tagSeo = await taxRepo.create({
		name: "tag",
		slug: "seo",
		label: "SEO",
		locale: "en",
	});
	return { cat, tagAi, tagSeo };
}

describeEachDialect("Content taxonomies field - create/update", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(ctx);
	});

	it("attaches taxonomy terms on create by slug", async () => {
		await seedTerms(ctx.db);

		const result = await handleContentCreate(ctx.db, "post", {
			data: { title: "Hello" },
			taxonomies: { category: ["porady"], tag: ["ai", "seo"] },
		});
		expect(result.success).toBe(true);

		const taxRepo = new TaxonomyRepository(ctx.db);
		const entryId = result.data!.item.id;
		const cats = await taxRepo.getTermsForEntry("post", entryId, "category");
		const tags = await taxRepo.getTermsForEntry("post", entryId, "tag");
		expect(cats.map((t) => t.slug).toSorted()).toEqual(["porady"]);
		expect(tags.map((t) => t.slug).toSorted()).toEqual(["ai", "seo"]);
	});

	it("returns VALIDATION_ERROR and rolls back the whole write when a slug is unknown", async () => {
		await seedTerms(ctx.db);

		const result = await handleContentCreate(ctx.db, "post", {
			data: { title: "Rolled back" },
			slug: "rolled-back",
			taxonomies: { tag: ["ai", "does-not-exist"] },
		});
		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("VALIDATION_ERROR");
		expect(result.error?.message).toContain("does-not-exist");

		// The transaction must have rolled back. No orphan content row and no
		// partial term assignment for the tag that did exist.
		const list = await ctx.db
			.selectFrom("ec_post")
			.selectAll()
			.where("slug", "=", "rolled-back")
			.execute();
		expect(list).toHaveLength(0);
	});

	it("rejects taxonomies with a non-array value", async () => {
		await seedTerms(ctx.db);

		const result = await handleContentCreate(ctx.db, "post", {
			data: { title: "Bad shape" },
			// eslint-disable-next-line typescript/no-explicit-any -- deliberately malformed
			taxonomies: { tag: "ai" as any },
		});
		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("VALIDATION_ERROR");
	});

	it("replaces existing assignments on update (setTermsForEntry semantics)", async () => {
		const { tagAi, tagSeo } = await seedTerms(ctx.db);
		const taxRepo = new TaxonomyRepository(ctx.db);

		const created = await handleContentCreate(ctx.db, "post", {
			data: { title: "Replace me" },
			taxonomies: { tag: ["ai", "seo"] },
		});
		expect(created.success).toBe(true);
		const entryId = created.data!.item.id;

		const updated = await handleContentUpdate(ctx.db, "post", entryId, {
			taxonomies: { tag: ["seo"] },
		});
		expect(updated.success).toBe(true);

		const tags = await taxRepo.getTermsForEntry("post", entryId, "tag");
		expect(tags.map((t) => t.slug)).toEqual(["seo"]);
		// Sanity: we didn't just wipe the taxonomies table.
		expect((await taxRepo.findById(tagAi.id))?.slug).toBe("ai");
		expect((await taxRepo.findById(tagSeo.id))?.slug).toBe("seo");
	});

	it("clears a taxonomy when passed an empty array", async () => {
		await seedTerms(ctx.db);
		const taxRepo = new TaxonomyRepository(ctx.db);

		const created = await handleContentCreate(ctx.db, "post", {
			data: { title: "Clear me" },
			taxonomies: { tag: ["ai"] },
		});
		const entryId = created.data!.item.id;

		const updated = await handleContentUpdate(ctx.db, "post", entryId, {
			taxonomies: { tag: [] },
		});
		expect(updated.success).toBe(true);

		const tags = await taxRepo.getTermsForEntry("post", entryId, "tag");
		expect(tags).toEqual([]);
	});

	it("leaves untouched taxonomies alone (only rewrites named ones)", async () => {
		await seedTerms(ctx.db);
		const taxRepo = new TaxonomyRepository(ctx.db);

		const created = await handleContentCreate(ctx.db, "post", {
			data: { title: "Selective update" },
			taxonomies: { category: ["porady"], tag: ["ai"] },
		});
		const entryId = created.data!.item.id;

		// Update only `tag`; `category` must survive.
		const updated = await handleContentUpdate(ctx.db, "post", entryId, {
			taxonomies: { tag: ["seo"] },
		});
		expect(updated.success).toBe(true);

		const cats = await taxRepo.getTermsForEntry("post", entryId, "category");
		const tags = await taxRepo.getTermsForEntry("post", entryId, "tag");
		expect(cats.map((t) => t.slug)).toEqual(["porady"]);
		expect(tags.map((t) => t.slug)).toEqual(["seo"]);
	});

	it("resolves slugs in the entry's locale for i18n sites", async () => {
		setI18nConfig({
			defaultLocale: "en",
			locales: [
				{ code: "en", label: "English" },
				{ code: "fr", label: "Français" },
			],
		});

		const taxRepo = new TaxonomyRepository(ctx.db);
		const enTag = await taxRepo.create({
			name: "tag",
			slug: "news",
			label: "News",
			locale: "en",
		});
		await taxRepo.create({
			name: "tag",
			slug: "actualites",
			label: "Actualités",
			locale: "fr",
			translationOf: enTag.id,
		});

		// EN entry references the EN slug.
		const enResult = await handleContentCreate(ctx.db, "post", {
			data: { title: "Hello" },
			locale: "en",
			taxonomies: { tag: ["news"] },
		});
		expect(enResult.success).toBe(true);

		// FR entry references the FR slug. The EN slug must NOT resolve here.
		const frResult = await handleContentCreate(ctx.db, "post", {
			data: { title: "Bonjour" },
			locale: "fr",
			taxonomies: { tag: ["actualites"] },
		});
		expect(frResult.success).toBe(true);

		const frFailure = await handleContentCreate(ctx.db, "post", {
			data: { title: "Bonjour 2" },
			slug: "bonjour-2",
			locale: "fr",
			taxonomies: { tag: ["news"] },
		});
		expect(frFailure.success).toBe(false);
		expect(frFailure.error?.code).toBe("VALIDATION_ERROR");
	});
});
