/**
 * Folded hydration in the live loader.
 *
 * `loadEntry` / `loadCollection` fold byline and taxonomy hydration into the
 * content query as correlated JSON-array subqueries, so a fetch is one round
 * trip instead of three. The aggregation SQL is dialect-specific (SQLite
 * `json_group_array`/`json_object` returns a string; Postgres
 * `json_agg`/`json_build_object` returns parsed JSON), so this runs on both
 * dialects to guard the fold end-to-end.
 */

import { afterEach, beforeEach, expect, it } from "vitest";

import { resetBylineFieldDefsCacheForTests } from "../../src/bylines/field-defs-cache.js";
import { BylineRepository } from "../../src/database/repositories/byline.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { ContentBylineCredit } from "../../src/database/repositories/types.js";
import { setI18nConfig } from "../../src/i18n/config.js";
import { emdashLoader, FOLDED_BYLINES, FOLDED_TERMS } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { BylineSchemaRegistry } from "../../src/schema/byline-registry.js";
import {
	type DialectTestContext,
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
} from "../utils/test-db.js";

interface FoldedByline {
	roleLabel: string | null;
	sortOrder: number;
	byline: { displayName: string; slug: string; avatarMediaId: string | null };
}
interface FoldedTerm {
	name: string;
	slug: string;
	label: string;
	locale: string;
}

describeEachDialect("loader hydration fold", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});
	afterEach(async () => {
		resetBylineFieldDefsCacheForTests();
		await teardownForDialect(ctx);
	});

	async function seedPost() {
		// eslint-disable-next-line typescript/no-explicit-any -- schema type vs Database type
		const db = ctx.db as any;
		const content = new ContentRepository(db);
		const bylines = new BylineRepository(db);
		const tax = new TaxonomyRepository(db);

		const post = await content.create({
			type: "post",
			slug: "fold-me",
			data: { title: "Fold me" },
			locale: "en",
		});
		// loadCollection filters status=published by default.
		await db
			.updateTable("ec_post")
			.set({ status: "published" })
			.where("id", "=", post.id)
			.execute();
		// Media row backing the avatar (byline.avatar_media_id has an FK to it).
		await db
			.insertInto("media")
			.values({
				id: "media_ada_avatar",
				filename: "ada.png",
				mime_type: "image/png",
				storage_key: "media_ada_avatar.png",
				status: "ready",
			})
			.execute();
		const author = await bylines.create({
			displayName: "Ada Lovelace",
			slug: "ada",
			avatarMediaId: "media_ada_avatar",
		});
		const editor = await bylines.create({
			displayName: "Grace Hopper",
			slug: "grace",
		});
		await bylines.setContentBylines("post", post.id, [
			{ bylineId: editor.id, roleLabel: "Editor" },
			{ bylineId: author.id, roleLabel: "Author" },
		]);
		const tag = await tax.create({ name: "tag", slug: "news", label: "News", locale: "en" });
		await tax.attachToEntry("post", post.id, tag.id);
		return { post, author, editor, tag };
	}

	function read<T>(data: unknown, sym: symbol): T {
		return (data as Record<symbol, unknown>)[sym] as T;
	}

	it("folds bylines + terms into loadEntry (one query, correct data)", async () => {
		await seedPost();
		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db: ctx.db }, () =>
			loader.loadEntry({ filter: { type: "post", id: "fold-me" } }),
		);
		// eslint-disable-next-line typescript/no-explicit-any -- loader result union
		const data = (result as any).data as Record<string, unknown>;

		const terms = read<FoldedTerm[]>(data, FOLDED_TERMS);
		expect(terms).toHaveLength(1);
		expect(terms[0]).toMatchObject({ name: "tag", slug: "news", label: "News" });

		const credits = read<FoldedByline[]>(data, FOLDED_BYLINES);
		expect(credits).toHaveLength(2);
		const ada = credits.find((credit) => credit.byline.slug === "ada");
		expect(ada?.roleLabel).toBe("Author");
		expect(ada?.byline.displayName).toBe("Ada Lovelace");
		// avatarMediaId is a required BylineSummary field templates read to render
		// author avatars; the fold must carry it (regression guard).
		expect(ada?.byline.avatarMediaId).toBe("media_ada_avatar");

		const publicCredits = data.bylines as ContentBylineCredit[];
		expect(
			publicCredits.map((credit) => ({
				displayName: credit.byline.displayName,
				roleLabel: credit.roleLabel,
				sortOrder: credit.sortOrder,
				source: credit.source,
				isGuest: credit.byline.isGuest,
				customFields: credit.byline.customFields,
			})),
		).toEqual([
			{
				displayName: "Grace Hopper",
				roleLabel: "Editor",
				sortOrder: 0,
				source: "explicit",
				isGuest: false,
				customFields: {},
			},
			{
				displayName: "Ada Lovelace",
				roleLabel: "Author",
				sortOrder: 1,
				source: "explicit",
				isGuest: false,
				customFields: {},
			},
		]);
		expect(data.byline).toBe(publicCredits[0]!.byline);
	});

	it("folds bylines + terms into loadCollection", async () => {
		await seedPost();
		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db: ctx.db }, () =>
			loader.loadCollection({ filter: { type: "post" } }),
		);
		// eslint-disable-next-line typescript/no-explicit-any -- loader result union
		const entry = (result as any).entries[0];
		expect(read<FoldedTerm[]>(entry.data, FOLDED_TERMS)[0]!.slug).toBe("news");
		expect(
			(entry.data.bylines as ContentBylineCredit[]).map((credit) => credit.byline.displayName),
		).toEqual(["Grace Hopper", "Ada Lovelace"]);
		expect(entry.data.byline.displayName).toBe("Grace Hopper");
	});

	it("uses the folded public shape when byline custom fields are registered", async () => {
		// eslint-disable-next-line typescript/no-explicit-any -- schema type vs Database type
		const db = ctx.db as any;
		const content = new ContentRepository(db);
		const bylines = new BylineRepository(db);
		const fields = new BylineSchemaRegistry(ctx.db);
		await fields.createField({ slug: "job_title", label: "Job title", type: "string" });
		resetBylineFieldDefsCacheForTests();
		const author = await bylines.create({
			displayName: "Ada Lovelace",
			slug: "ada-custom",
			customFields: { job_title: "Editor" },
		});
		const post = await content.create({
			type: "post",
			slug: "custom-fields",
			data: { title: "Custom fields" },
			locale: "en",
		});
		await bylines.setContentBylines("post", post.id, [
			{ bylineId: author.id, roleLabel: "Author" },
		]);
		expect((await bylines.findById(author.id))?.customFields?.job_title).toBe("Editor");

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db: ctx.db }, () =>
			loader.loadEntry({ filter: { type: "post", id: "custom-fields" } }),
		);
		// eslint-disable-next-line typescript/no-explicit-any -- loader result union
		const data = (result as any).data as { bylines: ContentBylineCredit[] };
		expect(data.bylines[0]?.byline.customFields).toEqual({});
	});

	it("folds terms in the entry's own locale (#1441)", async () => {
		// eslint-disable-next-line typescript/no-explicit-any -- schema type vs Database type
		const db = ctx.db as any;
		const content = new ContentRepository(db);
		const bylines = new BylineRepository(db);
		const tax = new TaxonomyRepository(db);
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		try {
			const en = await content.create({
				type: "post",
				slug: "hello",
				data: { title: "Hello" },
				locale: "en",
			});
			const fr = await content.create({
				type: "post",
				slug: "bonjour",
				data: { title: "Bonjour" },
				locale: "fr",
				translationOf: en.id,
			});
			const enTag = await tax.create({ name: "tag", slug: "news", label: "News", locale: "en" });
			await tax.create({
				name: "tag",
				slug: "actualites",
				label: "Actualités",
				locale: "fr",
				translationOf: enTag.id,
			});
			await tax.attachToEntry("post", fr.id, enTag.id);
			const enAuthor = await bylines.create({
				displayName: "English Author",
				slug: "author",
				locale: "en",
			});
			await bylines.create({
				displayName: "Auteur français",
				slug: "auteur",
				locale: "fr",
				translationOf: enAuthor.id,
			});
			await bylines.setContentBylines("post", fr.id, [
				{ bylineId: enAuthor.id, roleLabel: "Author" },
			]);

			const loader = emdashLoader();
			const result = await runWithContext({ editMode: false, db: ctx.db }, () =>
				loader.loadEntry({ filter: { type: "post", id: "bonjour", locale: "fr" } }),
			);
			// eslint-disable-next-line typescript/no-explicit-any -- loader result union
			const data = (result as any).data;
			const terms = read<FoldedTerm[]>(data, FOLDED_TERMS);
			expect(terms).toHaveLength(1);
			expect(terms[0]!.slug).toBe("actualites");
			expect(data.bylines).toHaveLength(1);
			expect(data.bylines[0].byline.displayName).toBe("Auteur français");
			expect(data.bylines[0].byline.locale).toBe("fr");
			expect(data.byline.displayName).toBe("Auteur français");
		} finally {
			setI18nConfig(null);
		}
	});

	it("folds the default-locale variant when the entry-locale term is missing", async () => {
		// eslint-disable-next-line typescript/no-explicit-any -- schema type vs Database type
		const db = ctx.db as any;
		const content = new ContentRepository(db);
		const tax = new TaxonomyRepository(db);
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		try {
			const post = await content.create({
				type: "post",
				slug: "bonjour",
				data: { title: "Bonjour" },
				locale: "fr",
			});
			const tag = await tax.create({
				name: "tag",
				slug: "news",
				label: "News",
				locale: "en",
			});
			await tax.attachToEntry("post", post.id, tag.id);

			const loader = emdashLoader();
			const result = await runWithContext({ editMode: false, db: ctx.db }, () =>
				loader.loadEntry({ filter: { type: "post", id: "bonjour", locale: "fr" } }),
			);
			// eslint-disable-next-line typescript/no-explicit-any -- loader result union
			const terms = read<FoldedTerm[]>((result as any).data, FOLDED_TERMS);
			expect(terms).toEqual([
				expect.objectContaining({ slug: "news", label: "News", locale: "en" }),
			]);
		} finally {
			setI18nConfig(null);
		}
	});

	it("does not fold an arbitrary locale when exact and default variants are missing", async () => {
		// eslint-disable-next-line typescript/no-explicit-any -- schema type vs Database type
		const db = ctx.db as any;
		const content = new ContentRepository(db);
		const tax = new TaxonomyRepository(db);
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr", "ja"] });
		try {
			const post = await content.create({
				type: "post",
				slug: "bonjour",
				data: { title: "Bonjour" },
				locale: "fr",
			});
			const tag = await tax.create({
				name: "tag",
				slug: "nyusu",
				label: "ニュース",
				locale: "ja",
			});
			await tax.attachToEntry("post", post.id, tag.id);

			const loader = emdashLoader();
			const result = await runWithContext({ editMode: false, db: ctx.db }, () =>
				loader.loadEntry({ filter: { type: "post", id: "bonjour", locale: "fr" } }),
			);
			// eslint-disable-next-line typescript/no-explicit-any -- loader result union
			const terms = read<FoldedTerm[]>((result as any).data, FOLDED_TERMS);
			expect(terms).toEqual([]);
		} finally {
			setI18nConfig(null);
		}
	});

	it("returns empty folded arrays for content with no bylines/terms", async () => {
		// eslint-disable-next-line typescript/no-explicit-any -- schema type vs Database type
		const content = new ContentRepository(ctx.db as any);
		await content.create({ type: "post", slug: "bare", data: { title: "Bare" }, locale: "en" });
		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db: ctx.db }, () =>
			loader.loadEntry({ filter: { type: "post", id: "bare" } }),
		);
		// eslint-disable-next-line typescript/no-explicit-any -- loader result union
		const data = (result as any).data as Record<string, unknown>;
		expect(read<FoldedTerm[]>(data, FOLDED_TERMS)).toEqual([]);
		expect(read<FoldedByline[]>(data, FOLDED_BYLINES)).toEqual([]);
		expect(data.bylines).toEqual([]);
		expect(data.byline).toBeNull();
	});
});
