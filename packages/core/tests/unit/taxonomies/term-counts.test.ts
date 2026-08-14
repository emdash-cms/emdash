/**
 * Visible term counts (#581): term usage counts must reflect only entries
 * that are currently visible on the public site — committed published rows,
 * not scheduled or soft-deleted — across every count path (public
 * widget, single-term page, admin term list/get), scoped to the taxonomy's
 * declared collections.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { ulid } from "ulidx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleTermGet, handleTermList } from "../../../src/api/handlers/taxonomies.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database as DatabaseSchema } from "../../../src/database/types.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { fetchVisibleTermCounts } from "../../../src/taxonomies/term-counts.js";
import {
	D1_COMPOUND_SELECT_LIMIT,
	describeEachDialect,
	setupForDialectWithCollections,
	setupTestDatabaseWithCompoundSelectLimit,
	teardownForDialect,
	teardownTestDatabase,
	type DialectTestContext,
} from "../../utils/test-db.js";

// Mock loader.getDb so the runtime taxonomy functions read from our test db.
vi.mock("../../../src/loader.js", () => ({
	getDb: vi.fn(),
}));

import { getDb } from "../../../src/loader.js";
import { getTaxonomyTerms, getTerm } from "../../../src/taxonomies/index.js";

describeEachDialect("visible term counts (#581)", (dialect) => {
	let ctx: DialectTestContext;
	let taxRepo: TaxonomyRepository;
	let contentRepo: ContentRepository;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		taxRepo = new TaxonomyRepository(ctx.db);
		contentRepo = new ContentRepository(ctx.db);
		vi.mocked(getDb).mockResolvedValue(ctx.db);
		// The migration-seeded defs declare `["posts"]`; counts are scoped to
		// the declared collections, so point them at the test collections.
		await ctx.db
			.updateTable("_emdash_taxonomy_defs")
			.set({ collections: JSON.stringify(["post"]) })
			.where("name", "in", ["category", "tag"])
			.execute();
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
		vi.restoreAllMocks();
	});

	function createEntry(collection: string, slug: string, status = "published") {
		return contentRepo.create({
			type: collection,
			slug,
			status,
			data: { title: slug },
		});
	}

	async function setScheduled(collection: string, id: string, at: Date): Promise<void> {
		await sql`UPDATE ${sql.ref(`ec_${collection}`)} SET status = 'scheduled', scheduled_at = ${at.toISOString()} WHERE id = ${id}`.execute(
			ctx.db,
		);
	}

	async function softDelete(collection: string, id: string): Promise<void> {
		await sql`UPDATE ${sql.ref(`ec_${collection}`)} SET deleted_at = ${new Date().toISOString()} WHERE id = ${id}`.execute(
			ctx.db,
		);
	}

	async function insertDef(
		name: string,
		collections: string[],
		locale = "en",
		translationGroup?: string,
	): Promise<string> {
		const id = ulid();
		await ctx.db
			.insertInto("_emdash_taxonomy_defs")
			.values({
				id,
				name,
				label: name,
				label_singular: null,
				hierarchical: 0,
				collections: JSON.stringify(collections),
				locale,
				translation_group: translationGroup ?? id,
			})
			.execute();
		return id;
	}

	it("counts only visible entries on every path (widget, term page, admin)", async () => {
		const term = await taxRepo.create({ name: "category", slug: "tech", label: "Technology" });

		const published = await createEntry("post", "published");
		const draft = await createEntry("post", "draft-post", "draft");
		const scheduledFuture = await createEntry("post", "scheduled-future");
		const scheduledDue = await createEntry("post", "scheduled-due");
		const trashed = await createEntry("post", "trashed");

		await setScheduled("post", scheduledFuture.id, new Date(Date.now() + 60 * 60 * 1000));
		await setScheduled("post", scheduledDue.id, new Date(Date.now() - 60 * 60 * 1000));
		await softDelete("post", trashed.id);

		for (const entry of [published, draft, scheduledFuture, scheduledDue, trashed]) {
			await taxRepo.attachToEntry("post", entry.id, term.id);
		}

		// Only the committed published row is visible. Elapsed scheduling makes
		// a row eligible for promotion but does not expose it.
		const group = term.translationGroup ?? term.id;
		const counts = await fetchVisibleTermCounts(ctx.db, "category", ["post"]);
		expect(counts.get(group)).toBe(1);

		// Public widget (getTaxonomyTerms).
		const widgetTerms = await getTaxonomyTerms("category");
		expect(widgetTerms).toHaveLength(1);
		expect(widgetTerms[0]!.count).toBe(1);

		// Public single-term page (getTerm).
		const termPage = await getTerm("category", "tech");
		expect(termPage?.count).toBe(1);

		// Admin term list.
		const list = await handleTermList(ctx.db, "category");
		if (!list.success) throw new Error(list.error.message);
		expect(list.data.terms[0]!.count).toBe(1);

		// Admin single-term get.
		const get = await handleTermGet(ctx.db, "category", "tech");
		if (!get.success) throw new Error(get.error.message);
		expect(get.data.term.count).toBe(1);
	});

	it("aggregates across the taxonomy's declared collections in one map", async () => {
		await insertDef("topic", ["post", "page"]);
		const term = await taxRepo.create({ name: "topic", slug: "science", label: "Science" });

		const post = await createEntry("post", "science-post");
		const page = await createEntry("page", "science-page");
		const draftPage = await createEntry("page", "science-draft", "draft");
		await taxRepo.attachToEntry("post", post.id, term.id);
		await taxRepo.attachToEntry("page", page.id, term.id);
		await taxRepo.attachToEntry("page", draftPage.id, term.id);

		const counts = await fetchVisibleTermCounts(ctx.db, "topic", ["post", "page"]);
		expect(counts.get(term.translationGroup ?? term.id)).toBe(2);
	});

	it("excludes assignments in collections the taxonomy does not declare", async () => {
		// `category` declares only ["post"]; a pivot row written for a `page`
		// entry (schema drift — the route does not validate the collection) must
		// not inflate the count.
		const term = await taxRepo.create({ name: "category", slug: "tech", label: "Technology" });
		const post = await createEntry("post", "in-scope");
		const page = await createEntry("page", "out-of-scope");
		await taxRepo.attachToEntry("post", post.id, term.id);
		await taxRepo.attachToEntry("page", page.id, term.id);

		const counts = await fetchVisibleTermCounts(ctx.db, "category", ["post"]);
		expect(counts.get(term.translationGroup ?? term.id)).toBe(1);
	});

	it("does not mix counts between taxonomies sharing a collection", async () => {
		const cat = await taxRepo.create({ name: "category", slug: "tech", label: "Technology" });
		const tag = await taxRepo.create({ name: "tag", slug: "webdev", label: "WebDev" });

		const p1 = await createEntry("post", "p1");
		const p2 = await createEntry("post", "p2");
		await taxRepo.attachToEntry("post", p1.id, cat.id);
		await taxRepo.attachToEntry("post", p2.id, cat.id);
		await taxRepo.attachToEntry("post", p1.id, tag.id);

		const categoryCounts = await fetchVisibleTermCounts(ctx.db, "category", ["post"]);
		expect(categoryCounts.get(cat.translationGroup ?? cat.id)).toBe(2);
		// The tag term's group must not appear in the category map at all.
		expect(categoryCounts.has(tag.translationGroup ?? tag.id)).toBe(false);

		const tagCounts = await fetchVisibleTermCounts(ctx.db, "tag", ["post"]);
		expect(tagCounts.get(tag.translationGroup ?? tag.id)).toBe(1);
	});

	it("counts one logical content group once for each assigned term group", async () => {
		// Defs are per-locale — translate the seeded `category` def into FR so
		// the FR widget view resolves (same declared collections).
		const enDef = await ctx.db
			.selectFrom("_emdash_taxonomy_defs")
			.selectAll()
			.where("name", "=", "category")
			.executeTakeFirstOrThrow();
		await ctx.db
			.insertInto("_emdash_taxonomy_defs")
			.values({
				id: ulid(),
				name: "category",
				label: "Catégories",
				label_singular: null,
				hierarchical: enDef.hierarchical,
				collections: enDef.collections,
				locale: "fr",
				translation_group: enDef.translation_group ?? enDef.id,
			})
			.execute();

		const enTerm = await taxRepo.create({
			name: "category",
			slug: "news",
			label: "News",
			locale: "en",
		});
		const frTerm = await taxRepo.create({
			name: "category",
			slug: "actualites",
			label: "Actualités",
			locale: "fr",
			translationOf: enTerm.id,
		});
		const featured = await taxRepo.create({
			name: "category",
			slug: "featured",
			label: "Featured",
			locale: "en",
		});

		const enPost = await contentRepo.create({
			type: "post",
			slug: "hello",
			status: "published",
			data: { title: "Hello" },
			locale: "en",
		});
		const frPost = await contentRepo.create({
			type: "post",
			slug: "bonjour",
			status: "published",
			data: { title: "Bonjour" },
			locale: "fr",
			translationOf: enPost.id,
		});
		// Attaching via either locale's term id resolves to the shared group.
		await taxRepo.attachToEntry("post", enPost.id, enTerm.id);
		await taxRepo.attachToEntry("post", frPost.id, featured.id);

		const counts = await fetchVisibleTermCounts(ctx.db, "category", ["post"]);
		expect(counts.get(enTerm.translationGroup ?? enTerm.id)).toBe(1);
		expect(counts.get(featured.translationGroup ?? featured.id)).toBe(1);

		// Both locale views of the taxonomy surface the same group count.
		const enTerms = await getTaxonomyTerms("category", { locale: "en" });
		const frTerms = await getTaxonomyTerms("category", { locale: "fr" });
		expect(enTerms.find((term) => term.id === enTerm.id)?.count).toBe(1);
		expect(frTerms.find((term) => term.id === frTerm.id)?.count).toBe(1);
	});

	it("skips missing ec_* tables and returns a partial count", async () => {
		// A declared collection whose table was never created (pre-migration
		// drift) must not break counting for the collections that do exist.
		await ctx.db
			.updateTable("_emdash_taxonomy_defs")
			.set({ collections: JSON.stringify(["ghost", "post"]) })
			.where("name", "=", "category")
			.execute();

		const term = await taxRepo.create({ name: "category", slug: "tech", label: "Technology" });
		const post = await createEntry("post", "p1");
		await taxRepo.attachToEntry("post", post.id, term.id);

		const counts = await fetchVisibleTermCounts(ctx.db, "category", ["ghost", "post"]);
		expect(counts.get(term.translationGroup ?? term.id)).toBe(1);

		const termPage = await getTerm("category", "tech");
		expect(termPage?.count).toBe(1);
	});

	it("does not share request-cached counts across differing collection scopes", async () => {
		// Nothing forces per-locale rows of the same def to declare identical
		// collections. When they drift, a request that renders both locales must
		// not serve the first locale's counts to the second — the request-cache
		// key has to include the collection scope, not just the taxonomy name.
		const enDefId = await insertDef("drifty", ["post"], "en");
		await insertDef("drifty", ["page"], "fr", enDefId);

		const enTerm = await taxRepo.create({
			name: "drifty",
			slug: "shared",
			label: "Shared",
			locale: "en",
		});
		await taxRepo.create({
			name: "drifty",
			slug: "partage",
			label: "Partagé",
			locale: "fr",
			translationOf: enTerm.id,
		});

		const post = await createEntry("post", "p1");
		const page1 = await createEntry("page", "g1");
		const page2 = await createEntry("page", "g2");
		await taxRepo.attachToEntry("post", post.id, enTerm.id);
		await taxRepo.attachToEntry("page", page1.id, enTerm.id);
		await taxRepo.attachToEntry("page", page2.id, enTerm.id);

		await runWithContext({ editMode: false }, async () => {
			const enTerms = await getTaxonomyTerms("drifty", { locale: "en" });
			const frTerms = await getTaxonomyTerms("drifty", { locale: "fr" });
			// EN def scopes to ["post"] (1 entry), FR def to ["page"] (2 entries).
			expect(enTerms[0]!.count).toBe(1);
			expect(frTerms[0]!.count).toBe(2);
		});
	});

	it("returns an empty map when the taxonomy declares no collections", async () => {
		await insertDef("empty_tax", []);
		const term = await taxRepo.create({ name: "empty_tax", slug: "lonely", label: "Lonely" });
		const post = await createEntry("post", "p1");
		await taxRepo.attachToEntry("post", post.id, term.id);

		const counts = await fetchVisibleTermCounts(ctx.db, "empty_tax", []);
		expect(counts.size).toBe(0);
	});
});

describe("visible term counts past the compound-SELECT ceiling", () => {
	let db: Kysely<DatabaseSchema>;
	let statements: string[];

	/** Back the test by a database that declares `limit` (null: no ceiling). */
	async function useDatabase(limit: number | null): Promise<void> {
		({ db, statements } = await setupTestDatabaseWithCompoundSelectLimit(limit));
	}

	/** How many statements the count query took; its subquery alias is unique to it. */
	function countStatements(): number {
		return statements.filter((source) => source.includes("per_collection")).length;
	}

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	/**
	 * Declare `collections` on a taxonomy, create a table and one published,
	 * term-tagged entry for each of `existing`, and return the term.
	 */
	async function seedTaxonomy(collections: string[], existing: string[]) {
		const registry = new SchemaRegistry(db);
		const contentRepo = new ContentRepository(db);
		const taxRepo = new TaxonomyRepository(db);

		for (const slug of existing) {
			await registry.createCollection({ slug, label: slug, labelSingular: slug });
			await registry.createField(slug, { slug: "title", label: "Title", type: "string" });
		}

		const defId = ulid();
		await db
			.insertInto("_emdash_taxonomy_defs")
			.values({
				id: defId,
				name: "topic",
				label: "Topics",
				label_singular: null,
				hierarchical: 0,
				collections: JSON.stringify(collections),
				locale: "en",
				translation_group: defId,
			})
			.execute();

		const term = await taxRepo.create({ name: "topic", slug: "science", label: "Science" });
		for (const slug of existing) {
			const entry = await contentRepo.create({
				type: slug,
				slug: `${slug}-entry`,
				status: "published",
				data: { title: slug },
			});
			await taxRepo.attachToEntry(slug, entry.id, term.id);
		}
		return term;
	}

	function collectionSlugs(count: number): string[] {
		return Array.from({ length: count }, (_, i) => `coll_${String(i)}`);
	}

	it("aggregates every declared collection when there are more than one statement can carry", async () => {
		await useDatabase(D1_COMPOUND_SELECT_LIMIT);
		const slugs = collectionSlugs(D1_COMPOUND_SELECT_LIMIT + 1);
		const term = await seedTaxonomy(slugs, slugs);

		const counts = await fetchVisibleTermCounts(db, "topic", slugs);
		expect(counts.get(term.translationGroup ?? term.id)).toBe(slugs.length);
		expect(countStatements()).toBe(2);

		const list = await handleTermList(db, "topic");
		if (!list.success) throw new Error(list.error.code);
		expect(list.data.terms[0]!.count).toBe(slugs.length);
	});

	it("still skips a missing ec_* table when it falls beyond the first batch", async () => {
		await useDatabase(D1_COMPOUND_SELECT_LIMIT);
		const existing = collectionSlugs(D1_COMPOUND_SELECT_LIMIT);
		const term = await seedTaxonomy([...existing, "ghost"], existing);

		const counts = await fetchVisibleTermCounts(db, "topic", [...existing, "ghost"]);
		expect(counts.get(term.translationGroup ?? term.id)).toBe(existing.length);
	});

	it("takes a single statement on a backend that declares no ceiling", async () => {
		await useDatabase(null);
		const slugs = collectionSlugs(D1_COMPOUND_SELECT_LIMIT + 1);
		const term = await seedTaxonomy(slugs, slugs);

		const counts = await fetchVisibleTermCounts(db, "topic", slugs);
		expect(counts.get(term.translationGroup ?? term.id)).toBe(slugs.length);
		expect(countStatements()).toBe(1);
	});
});
