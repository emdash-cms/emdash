import type {
	Kysely,
	KyselyPlugin,
	PluginTransformQueryArgs,
	PluginTransformResultArgs,
	QueryResult,
	RootOperationNode,
	UnknownRow,
} from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BylineRepository } from "../../../src/database/repositories/byline.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database } from "../../../src/database/types.js";
import {
	applySeedWithinBudget,
	type SeedApplyBudget,
	type SeedApplyProgress,
} from "../../../src/seed/apply.js";
import type { SeedFile } from "../../../src/seed/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

class QueryCountingPlugin implements KyselyPlugin {
	count = 0;

	transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
		this.count += 1;
		return args.node;
	}

	transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
		return Promise.resolve(args.result);
	}
}

/** Apply the seed call after call until one completes, recording each call's queries. */
async function applyInCalls(
	db: Kysely<Database>,
	seed: SeedFile,
	budget: SeedApplyBudget,
): Promise<{ completed: boolean[]; queries: number[]; progress: SeedApplyProgress[] }> {
	const completed: boolean[] = [];
	const queries: number[] = [];
	const progress: SeedApplyProgress[] = [];
	for (let call = 0; call < 500; call++) {
		const counter = new QueryCountingPlugin();
		const outcome = await applySeedWithinBudget(
			db.withPlugin(counter),
			seed,
			{ includeContent: true },
			budget,
		);
		completed.push(outcome.complete);
		queries.push(counter.count);
		progress.push(outcome.progress);
		if (outcome.complete) return { completed, queries, progress };
	}
	throw new Error("The seed did not complete within 500 calls");
}

function plainSeed(collections: string[], entriesPerCollection: number): SeedFile {
	return {
		version: "1",
		collections: collections.map((slug) => ({
			slug,
			label: slug,
			fields: [{ slug: "title", label: "Title", type: "string" as const }],
		})),
		content: Object.fromEntries(
			collections.map((slug) => [
				slug,
				Array.from({ length: entriesPerCollection }, (_, index) => ({
					id: `${slug}-${index}`,
					slug: `${slug}-${index}`,
					data: { title: `Entry ${index}` },
				})),
			]),
		),
	};
}

describe("applySeed with a budget", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("resolves references, term parents, bylines and menus across calls as a single call does", async () => {
		const seed: SeedFile = {
			version: "1",
			collections: [
				{
					slug: "pages",
					label: "Pages",
					fields: [{ slug: "title", label: "Title", type: "string" }],
				},
				{
					slug: "posts",
					label: "Posts",
					fields: [
						{ slug: "title", label: "Title", type: "string" },
						{ slug: "related_page", label: "Related page", type: "reference" },
					],
				},
			],
			taxonomies: [
				{
					name: "category",
					label: "Categories",
					hierarchical: true,
					collections: ["posts"],
					terms: [
						{ slug: "news", label: "News" },
						{ slug: "local", label: "Local", parent: "news" },
					],
				},
			],
			bylines: [
				{ id: "byline-ada", slug: "ada", displayName: "Ada" },
				{ id: "byline-bo", slug: "bo", displayName: "Bo" },
			],
			content: {
				pages: [{ id: "about-page", slug: "about", data: { title: "About" } }],
				posts: ["one", "two", "three"].map((slug) => ({
					id: `post-${slug}`,
					slug,
					data: { title: slug, related_page: "$ref:about-page" },
					taxonomies: { category: ["local"] },
					bylines: [{ byline: "byline-bo" }],
				})),
			},
			menus: [
				{
					name: "main",
					label: "Main",
					items: [{ type: "page", label: "Three", ref: "post-three", collection: "posts" }],
				},
			],
		};

		const { completed, progress } = await applyInCalls(db, seed, { queries: 1 });

		// One item per call: two terms, two bylines, four entries, then the menus.
		expect(completed).toEqual([...Array.from<boolean>({ length: 8 }).fill(false), true]);
		expect(progress.map((step) => step.done)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 8]);
		expect(progress.every((step) => step.total === 8)).toBe(true);

		const terms = new TaxonomyRepository(db);
		const news = await terms.findBySlug("category", "news");
		const local = await terms.findBySlug("category", "local");
		expect(local?.parentId).toBe(news?.translationGroup);

		const content = new ContentRepository(db);
		const bylines = new BylineRepository(db);
		const about = await content.findBySlug("pages", "about");
		const posts = await Promise.all(
			["one", "two", "three"].map((slug) => content.findBySlug("posts", slug)),
		);
		for (const post of posts) {
			expect(post?.data.related_page).toBe(about?.id);
			expect(post?.liveRevisionId).toBeTruthy();
			const assigned = await db
				.selectFrom("content_taxonomies")
				.select("taxonomy_id")
				.where("entry_id", "=", post!.id)
				.execute();
			expect(assigned).toEqual([{ taxonomy_id: local?.translationGroup }]);
			const credits = await bylines.getContentBylines("posts", post!.id);
			expect(credits.map((credit) => credit.byline.slug)).toEqual(["bo"]);
		}

		const menus = await db.selectFrom("_emdash_menus").select("id").execute();
		const items = await db.selectFrom("_emdash_menu_items").select("reference_id").execute();
		expect(menus).toHaveLength(1);
		expect(items).toEqual([{ reference_id: posts[2]!.id }]);
	});

	it("keeps every call near its budget, however many entries earlier calls wrote", async () => {
		const budget = 150;
		const seed = plainSeed(["pages", "posts", "events", "places"], 60);

		const { queries } = await applyInCalls(db, seed, { queries: budget });

		expect(queries.length).toBeGreaterThan(1);
		expect(Math.max(...queries)).toBeLessThanOrEqual(budget + 25);
		const rows = await db
			.selectFrom("ec_places" as never)
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.executeTakeFirstOrThrow();
		expect(rows.count).toBe(60);
	});

	it("keeps every call near its budget while it creates many terms and bylines", async () => {
		const budget = 150;
		const seed: SeedFile = {
			...plainSeed(["posts"], 20),
			taxonomies: [
				{
					name: "tag",
					label: "Tags",
					hierarchical: false,
					collections: ["posts"],
					terms: Array.from({ length: 200 }, (_, index) => ({
						slug: `tag-${index}`,
						label: `Tag ${index}`,
					})),
				},
				{
					name: "category",
					label: "Categories",
					hierarchical: true,
					collections: ["posts"],
					terms: Array.from({ length: 200 }, (_, index) => ({
						slug: `category-${index}`,
						label: `Category ${index}`,
						...(index >= 10 ? { parent: `category-${index % 10}` } : {}),
					})),
				},
			],
			bylines: Array.from({ length: 200 }, (_, index) => ({
				id: `byline-${index}`,
				slug: `author-${index}`,
				displayName: `Author ${index}`,
			})),
		};

		const { queries, progress } = await applyInCalls(db, seed, { queries: budget });

		expect(queries.length).toBeGreaterThan(1);
		expect(Math.max(...queries)).toBeLessThanOrEqual(budget + 25);
		const done = progress.slice(0, -1).map((step) => step.done);
		expect(done.every((value, index) => index === 0 || value > done[index - 1]!)).toBe(true);
		expect(progress.at(-1)).toEqual({ done: 620, total: 620 });
		for (const [name, count] of [
			["tag", 200],
			["category", 200],
		] as const) {
			const rows = await db
				.selectFrom("taxonomies")
				.select((eb) => eb.fn.countAll<number>().as("count"))
				.where("name", "=", name)
				.executeTakeFirstOrThrow();
			expect(rows.count).toBe(count);
		}
		const bylineRows = await db
			.selectFrom("_emdash_bylines")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.executeTakeFirstOrThrow();
		expect(bylineRows.count).toBe(200);
		const child = await new TaxonomyRepository(db).findBySlug("category", "category-199");
		const parent = await new TaxonomyRepository(db).findBySlug("category", "category-9");
		expect(child?.parentId).toBe(parent?.translationGroup);
	});

	it("refuses a budget unless conflicts are skipped", async () => {
		const seed = plainSeed(["pages"], 1);

		await expect(
			applySeedWithinBudget(
				db,
				seed,
				{ includeContent: true, onConflict: "update" },
				{ queries: 10 },
			),
		).rejects.toThrow('A seed budget requires onConflict: "skip"');
	});
});
