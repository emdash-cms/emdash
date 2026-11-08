import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ContentRepository } from "../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
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
	const assignments = await new TaxonomyRepository(db).getTermAssignmentsForEntry(
		"posts",
		post!.id,
		"category",
		"fr",
		"fr",
	);
	return assignments
		.map(({ term }) => (term ? { locale: term.locale, label: term.label, slug: term.slug } : null))
		.toSorted((a, b) => (a?.label ?? "").localeCompare(b?.label ?? ""));
}

type TranslationTermVariant = "english-only" | "separate" | "linked";

function translatedTaxonomySeed(variant: TranslationTermVariant, includeTerms = true): SeedFile {
	const seed = taxonomySeed([], "en");
	const frenchTaxonomy = seed.taxonomies![0]!;
	const englishTaxonomy = seed.taxonomies![1]!;
	if (variant === "english-only") frenchTaxonomy.terms = [];
	if (variant === "linked") englishTaxonomy.terms![0]!.translationOf = "term-guides-fr";
	const taxonomies = includeTerms ? { category: ["guides"] } : {};
	seed.content = {
		posts: [
			{
				id: "post-en",
				slug: "article-en",
				locale: "en",
				status: "published",
				taxonomies,
				data: { title: "Article EN" },
			},
			{
				id: "post-fr",
				slug: "article-fr",
				locale: "fr",
				translationOf: "post-en",
				status: "published",
				taxonomies,
				data: { title: "Article FR" },
			},
		],
	};
	return seed;
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
		const terms = await new TaxonomyRepository(ctx.db).getTermAssignmentsForEntry(
			"posts",
			post!.id,
			"category",
			"fr",
			"fr",
		);
		expect(
			terms.flatMap(({ term }) => (term ? [{ locale: term.locale, label: term.label }] : [])),
		).toEqual([{ locale: "fr", label: "Guides FR" }]);
	});

	for (const variant of [
		{
			name: "an English-only term",
			kind: "english-only" as const,
			french: [{ locale: "en", label: "Guides EN", slug: "guides" }],
		},
		{
			name: "separate locale terms",
			kind: "separate" as const,
			french: [{ locale: "fr", label: "Guides FR", slug: "guides" }],
		},
		{
			name: "linked locale terms",
			kind: "linked" as const,
			french: [{ locale: "fr", label: "Guides FR", slug: "guides" }],
		},
	]) {
		it(`preserves translated taxonomy assignments on update with ${variant.name}`, async () => {
			const seed = translatedTaxonomySeed(variant.kind);
			const taxonomyRepo = new TaxonomyRepository(ctx.db);
			for (const onConflict of ["skip", "update"] as const) {
				await applySeed(ctx.db, seed, { includeContent: true, onConflict });
				const contentRepo = new ContentRepository(ctx.db);
				const englishPost = await contentRepo.findBySlug("posts", "article-en", "en");
				const frenchPost = await contentRepo.findBySlug("posts", "article-fr", "fr");
				expect(englishPost).not.toBeNull();
				expect(frenchPost).not.toBeNull();
				expect(englishPost!.translationGroup).toBeTruthy();
				expect(frenchPost!.translationGroup).toBe(englishPost!.translationGroup);

				const expected = {
					en: [{ locale: "en", label: "Guides EN", slug: "guides" }],
					fr: variant.french,
				};
				for (const locale of ["en", "fr"] as const) {
					const post = await new ContentRepository(ctx.db).findBySlug(
						"posts",
						`article-${locale}`,
						locale,
					);
					expect(post).not.toBeNull();
					const assignments = await taxonomyRepo.getTermAssignmentsForEntry(
						"posts",
						post!.id,
						"category",
						locale,
						variant.kind === "english-only" ? "en" : locale,
					);
					expect(
						assignments.flatMap(({ term }) =>
							term ? [{ locale: term.locale, label: term.label, slug: term.slug }] : [],
						),
					).toEqual(expected[locale]);
				}
			}

			const cleared = translatedTaxonomySeed(variant.kind, false);
			await applySeed(ctx.db, cleared, { includeContent: true, onConflict: "update" });
			for (const locale of ["en", "fr"] as const) {
				const post = await new ContentRepository(ctx.db).findBySlug(
					"posts",
					`article-${locale}`,
					locale,
				);
				expect(post).not.toBeNull();
				expect(
					await taxonomyRepo.getTermAssignmentsForEntry(
						"posts",
						post!.id,
						"category",
						locale,
						locale,
					),
				).toEqual([]);
			}
		});
	}

	it("clears same-ID groups independently in different collections", async () => {
		const footer = { ...entry("fr", "Footer"), id: "footer", slug: undefined };
		const seed = taxonomySeed([footer], "fr");
		seed.collections![0]!.routable = false;
		seed.collections!.push({ ...seed.collections![0]!, slug: "snippets" });
		seed.taxonomies![0]!.collections = ["posts", "snippets"];
		seed.content!.snippets = [footer];
		await applySeed(ctx.db, seed, { includeContent: true });
		const repo = new TaxonomyRepository(ctx.db);
		for (const collection of ["posts", "snippets"]) {
			expect(
				await repo.getTermAssignmentsForEntry(collection, "footer", "category", "fr", "fr"),
			).toHaveLength(1);
		}

		const withoutTerms = { ...footer, taxonomies: {} };
		await applySeed(
			ctx.db,
			{ ...seed, content: { posts: [withoutTerms], snippets: [withoutTerms] } },
			{ includeContent: true, onConflict: "update" },
		);
		for (const collection of ["posts", "snippets"]) {
			expect(
				await repo.getTermAssignmentsForEntry(collection, "footer", "category", "fr", "fr"),
			).toEqual([]);
		}
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
