import type { Kysely, KyselyPlugin } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleTaxonomyCreate } from "../../src/api/handlers/taxonomies.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { Database } from "../../src/database/types.js";
import {
	__setTaxonomyNamesCacheForTests,
	emdashLoader,
	resetTaxonomyNamesCache,
} from "../../src/loader.js";
import { getEmDashCollection } from "../../src/query.js";
import { runWithContext } from "../../src/request-context.js";
import { getTaxonomyDefs } from "../../src/taxonomies/index.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

vi.mock("astro:content", () => ({
	getLiveCollection: vi.fn(),
	getLiveEntry: vi.fn(),
}));

import { getLiveCollection } from "astro:content";

describe("taxonomy names isolate cache", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		resetTaxonomyNamesCache();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		resetTaxonomyNamesCache();
		vi.mocked(getLiveCollection).mockReset();
	});

	function delegateToLoader() {
		const loader = emdashLoader();
		vi.mocked(getLiveCollection).mockImplementation(async (_name: string, filter: unknown) =>
			// eslint-disable-next-line typescript/no-explicit-any -- loader filter is a runtime-validated union
			loader.loadCollection!({ filter: filter as any }),
		);
	}

	async function seedPostWithTag() {
		const createResult = await handleTaxonomyCreate(db, {
			name: "topic",
			label: "Topics",
			collections: ["post"],
		});
		if (!createResult.success) throw new Error(String(createResult.error?.message));

		const taxRepo = new TaxonomyRepository(db);
		const term = await taxRepo.create({
			name: "topic",
			slug: "news",
			label: "News",
		});

		const contentRepo = new ContentRepository(db);
		const post = await contentRepo.create({
			type: "post",
			slug: "announcement",
			data: { title: "Announcement" },
			status: "published",
		});
		await taxRepo.attachToEntry("post", post.id, term.id);

		return { term, post };
	}

	it("bypasses the taxonomy-names cache during a route-cache fill", async () => {
		const { term, post } = await seedPostWithTag();
		// Seed the isolate cache as if it predates the new taxonomy definition.
		__setTaxonomyNamesCacheForTests(new Map<string, Set<string>>());
		delegateToLoader();

		const { entries } = await runWithContext({ editMode: false, db, routeCacheFill: true }, () =>
			getEmDashCollection("post", { where: { topic: term.slug } }),
		);

		expect(entries.map((entry) => entry.id)).toContain(post.slug);
	});

	it("shares taxonomy definition reads across route-cache fill calls", async () => {
		const { term, post } = await seedPostWithTag();
		const loader = emdashLoader();

		let definitionReads = 0;
		const plugin: KyselyPlugin = {
			transformQuery: (args) => {
				const sql = db.getExecutor().compileQuery(args.node, args.queryId).sql;
				if (/^\s*select\b/i.test(sql) && /\bfrom\s+"_emdash_taxonomy_defs"/i.test(sql)) {
					definitionReads++;
				}
				return args.node;
			},
			transformResult: (args) => Promise.resolve(args.result),
		};
		const counted = db.withPlugin(plugin);

		const [defs, tagged, announced] = await runWithContext(
			{ editMode: false, db: counted, routeCacheFill: true },
			() =>
				Promise.all([
					getTaxonomyDefs(),
					loader.loadCollection!({ filter: { type: "post", where: { topic: term.slug } } }),
					loader.loadCollection!({ filter: { type: "post", where: { title: "Announcement" } } }),
				]),
		);

		expect(defs.some((definition) => definition.name === "topic")).toBe(true);
		expect(tagged.entries!.map((entry) => entry.id)).toContain(post.slug);
		expect(announced.entries!.map((entry) => entry.id)).toContain(post.slug);
		expect(definitionReads).toBe(1);
	});

	it("uses the isolate taxonomy-names cache outside of route-cache fills", async () => {
		const { term } = await seedPostWithTag();
		__setTaxonomyNamesCacheForTests(new Map<string, Set<string>>());
		delegateToLoader();

		const { entries } = await runWithContext({ editMode: false, db }, () =>
			getEmDashCollection("post", { where: { topic: term.slug } }),
		);

		// With a stale empty name map, "topic" is mis-classified as a field filter
		// and the query returns no matches instead of the tagged post.
		expect(entries).toHaveLength(0);
	});
});
