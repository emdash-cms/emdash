import type {
	KyselyPlugin,
	PluginTransformQueryArgs,
	PluginTransformResultArgs,
	QueryResult,
	RootOperationNode,
	UnknownRow,
} from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

// Mock loader.getDb so the runtime taxonomy functions read from our test db.
vi.mock("../../../src/loader.js", () => ({
	getDb: vi.fn(),
}));

import { getDb } from "../../../src/loader.js";
import { getTerm } from "../../../src/taxonomies/index.js";

/**
 * Counts every query executed through the wrapped Kysely instance.
 * `transformQuery` runs once per execution, so it doubles as a
 * round-trip counter for asserting query budgets.
 */
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

describeEachDialect("getTerm", (dialect) => {
	let ctx: DialectTestContext;
	let taxRepo: TaxonomyRepository;
	let contentRepo: ContentRepository;
	let counter: QueryCountingPlugin;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		taxRepo = new TaxonomyRepository(ctx.db);
		contentRepo = new ContentRepository(ctx.db);
		counter = new QueryCountingPlugin();
		vi.mocked(getDb).mockResolvedValue(ctx.db.withPlugin(counter));
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
		vi.restoreAllMocks();
	});

	it("returns the term with usage count and children", async () => {
		const parent = await taxRepo.create({
			name: "category",
			slug: "tech",
			label: "Technology",
			data: { description: "All things tech" },
		});
		await taxRepo.create({
			name: "category",
			slug: "web",
			label: "Web",
			parentId: parent.id,
		});
		await taxRepo.create({
			name: "category",
			slug: "ai",
			label: "AI",
			parentId: parent.id,
		});

		const p1 = await contentRepo.create({
			type: "post",
			slug: "p1",
			data: { title: "P1" },
		});
		const p2 = await contentRepo.create({
			type: "post",
			slug: "p2",
			data: { title: "P2" },
		});
		await taxRepo.attachToEntry("post", p1.id, parent.id);
		await taxRepo.attachToEntry("post", p2.id, parent.id);

		const term = await getTerm("category", "tech");

		expect(term).not.toBeNull();
		expect(term?.id).toBe(parent.id);
		expect(term?.name).toBe("category");
		expect(term?.slug).toBe("tech");
		expect(term?.label).toBe("Technology");
		expect(term?.description).toBe("All things tech");
		expect(Number(term?.count)).toBe(2);
		// Children ordered by label
		expect(term?.children.map((c) => c.slug)).toEqual(["ai", "web"]);
		expect(term?.children.every((c) => c.parentId === parent.id)).toBe(true);
	});

	it("returns null for a non-existent term", async () => {
		const term = await getTerm("category", "does-not-exist");
		expect(term).toBeNull();
	});

	it("only returns children in the term's locale", async () => {
		const parent = await taxRepo.create({
			name: "category",
			slug: "tech",
			label: "Technology",
		});
		await taxRepo.create({
			name: "category",
			slug: "web",
			label: "Web",
			parentId: parent.id,
		});
		// A child row in a different locale must be filtered out.
		await ctx.db
			.insertInto("taxonomies")
			.values({
				id: "term_fr_child",
				name: "category",
				slug: "ouaib",
				label: "Ouaib",
				parent_id: parent.id,
				locale: "fr",
				translation_group: "term_fr_child",
			})
			.execute();

		const term = await getTerm("category", "tech");

		expect(term?.children.map((c) => c.slug)).toEqual(["web"]);
	});

	it("resolves the term in three queries (term, count, children)", async () => {
		const parent = await taxRepo.create({
			name: "category",
			slug: "tech",
			label: "Technology",
		});
		await taxRepo.create({
			name: "category",
			slug: "web",
			label: "Web",
			parentId: parent.id,
		});
		const post = await contentRepo.create({
			type: "post",
			slug: "p1",
			data: { title: "P1" },
		});
		await taxRepo.attachToEntry("post", post.id, parent.id);

		counter.count = 0;
		const term = await getTerm("category", "tech");

		expect(term).not.toBeNull();
		expect(Number(term?.count)).toBe(1);
		expect(term?.children).toHaveLength(1);
		// 1 term lookup + (count ∥ children) — anything more is a regression.
		expect(counter.count).toBe(3);
	});
});
