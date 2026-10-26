import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ContentRepository } from "../../src/database/repositories/content.js";
import type { Database } from "../../src/database/types.js";
import { setI18nConfig } from "../../src/i18n/config.js";
import { applySeed } from "../../src/seed/apply.js";
import type { SeedFile } from "../../src/seed/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../utils/test-db.js";

type LocaleVariant = {
	name: string;
	defaultLocale: string;
	entryLocale?: string;
};

const localeVariants: LocaleVariant[] = [
	{ name: "an omitted locale uses seed.defaultLocale", defaultLocale: "fr" },
	{
		name: "an explicit locale overrides seed.defaultLocale",
		defaultLocale: "en",
		entryLocale: "fr",
	},
];

function taxonomySeed(
	content: NonNullable<SeedFile["content"]>[string],
	defaultLocale: string,
): SeedFile {
	return {
		version: "1",
		defaultLocale,
		collections: [
			{
				slug: "posts",
				label: "Posts",
				labelSingular: "Post",
				fields: [{ slug: "title", label: "Title", type: "string" }],
			},
		],
		taxonomies: [
			{
				id: "taxonomy-category-fr",
				name: "category",
				label: "Catégories",
				hierarchical: true,
				collections: ["posts"],
				locale: "fr",
				terms: [{ id: "term-guides-fr", slug: "guides", label: "Guides FR", locale: "fr" }],
			},
			{
				id: "taxonomy-category-en",
				name: "category",
				label: "Categories",
				translationOf: "taxonomy-category-fr",
				locale: "en",
				terms: [
					{ id: "term-guides-en", slug: "guides", label: "Guides EN", locale: "en" },
					{
						id: "term-english-only",
						slug: "english-only",
						label: "English only",
						locale: "en",
					},
				],
			},
		],
		content: { posts: content },
	};
}

function entry(locale: string | undefined, title: string, term = "guides") {
	return {
		id: "post-fr",
		slug: "article-fr",
		...(locale ? { locale } : {}),
		status: "published" as const,
		taxonomies: { category: [term] },
		data: { title },
	};
}

async function assignedTerms(db: Kysely<Database>) {
	const post = await new ContentRepository(db).findBySlug("posts", "article-fr", "fr");
	expect(post).not.toBeNull();
	return db
		.selectFrom("content_taxonomies as ct")
		.innerJoin("taxonomies as t", "t.id", "ct.taxonomy_id")
		.select(["t.locale", "t.label", "t.slug"])
		.where("ct.entry_id", "=", post!.id)
		.where("ct.collection", "=", "posts")
		.orderBy("t.label")
		.execute();
}

describeEachDialect("seed taxonomy term locale", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		setI18nConfig(null);
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setI18nConfig(null);
		await teardownForDialect(ctx);
	});

	for (const variant of localeVariants) {
		it(`creates content with the French term when ${variant.name}`, async () => {
			await applySeed(
				ctx.db,
				taxonomySeed([entry(variant.entryLocale, "Article FR")], variant.defaultLocale),
				{ includeContent: true },
			);

			expect(await assignedTerms(ctx.db)).toEqual([
				{ locale: "fr", label: "Guides FR", slug: "guides" },
			]);
		});

		it(`updates content with the French term when ${variant.name}`, async () => {
			await applySeed(
				ctx.db,
				taxonomySeed([entry(variant.entryLocale, "Original title")], variant.defaultLocale),
				{ includeContent: true },
			);
			await applySeed(
				ctx.db,
				taxonomySeed([entry(variant.entryLocale, "Updated title")], variant.defaultLocale),
				{ includeContent: true, onConflict: "update" },
			);

			const post = await new ContentRepository(ctx.db).findBySlug("posts", "article-fr", "fr");
			expect(post?.data.title).toBe("Updated title");
			expect(await assignedTerms(ctx.db)).toEqual([
				{ locale: "fr", label: "Guides FR", slug: "guides" },
			]);
		});
	}

	it("uses the stored locale when updating a slugless entry by ID", async () => {
		const slugless = { ...entry("fr", "Original title"), slug: undefined };
		const seed = taxonomySeed([slugless], "fr");
		seed.collections![0]!.routable = false;
		await applySeed(ctx.db, seed, { includeContent: true });
		await applySeed(
			ctx.db,
			{
				...seed,
				defaultLocale: "en",
				content: {
					posts: [{ ...slugless, locale: undefined, data: { title: "Updated title" } }],
				},
			},
			{ includeContent: true, onConflict: "update" },
		);

		const post = await new ContentRepository(ctx.db).findById("posts", "post-fr");
		expect(post?.locale).toBe("fr");
		expect(post?.data.title).toBe("Updated title");
		const terms = await ctx.db
			.selectFrom("content_taxonomies as ct")
			.innerJoin("taxonomies as t", "t.id", "ct.taxonomy_id")
			.select(["t.locale", "t.label"])
			.where("ct.collection", "=", "posts")
			.where("ct.entry_id", "=", "post-fr")
			.execute();
		expect(terms).toEqual([{ locale: "fr", label: "Guides FR" }]);
	});

	for (const term of ["english-only", "nonexistent"]) {
		it(`warns and skips an unresolved term on create: ${term}`, async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			await applySeed(ctx.db, taxonomySeed([entry(undefined, "Article FR", term)], "fr"), {
				includeContent: true,
			});

			expect(warn).toHaveBeenCalledWith(
				`content.posts: taxonomy term "category/${term}" not found in locale "fr". Skipping assignment.`,
			);
			const post = await new ContentRepository(ctx.db).findBySlug("posts", "article-fr", "fr");
			expect(post?.data.title).toBe("Article FR");
			expect(await assignedTerms(ctx.db)).toEqual([]);
		});
	}

	it("warns and omits a foreign-locale replacement term on update", async () => {
		await applySeed(ctx.db, taxonomySeed([entry("fr", "Original title")], "en"), {
			includeContent: true,
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await applySeed(ctx.db, taxonomySeed([entry("fr", "Changed title", "english-only")], "en"), {
			includeContent: true,
			onConflict: "update",
		});

		expect(warn).toHaveBeenCalledWith(
			'content.posts: taxonomy term "category/english-only" not found in locale "fr". Skipping assignment.',
		);
		const post = await new ContentRepository(ctx.db).findBySlug("posts", "article-fr", "fr");
		expect(post?.data.title).toBe("Changed title");
		expect(post?.locale).toBe("fr");
		expect(await assignedTerms(ctx.db)).toEqual([]);
	});
});
