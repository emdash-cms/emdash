import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { searchCollection, searchWithDb } from "../../../src/search/query.js";
import { createPageFixture, createPostFixture } from "../../utils/fixtures.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

function portableText(text: string) {
	return [
		{
			_type: "block",
			style: "normal",
			children: [{ _type: "span", text }],
		},
	];
}

describe("search cross-collection ranking", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		repo = new ContentRepository(db);

		const registry = new SchemaRegistry(db);
		const fts = new FTSManager(db);

		await registry.updateField("page", "title", { searchable: true });
		await registry.updateField("page", "content", { searchable: true });
		await registry.updateField("post", "title", { searchable: true });
		await registry.updateField("post", "content", { searchable: true });

		await fts.enableSearch("page");
		await fts.enableSearch("post");
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("ranks an exact title match above passing mentions in a much larger collection", async () => {
		await repo.create(
			createPageFixture({
				slug: "roadmap",
				status: "published",
				data: { title: "Roadmap", content: portableText("Our roadmap page.") },
			}),
		);

		for (let i = 1; i <= 4; i++) {
			await repo.create(
				createPageFixture({
					slug: `page-${i}`,
					status: "published",
					data: {
						title: `Page ${i}`,
						content: portableText("See the roadmap for details."),
					},
				}),
			);
		}

		for (let i = 1; i <= 60; i++) {
			await repo.create(
				createPostFixture({
					slug: `post-${i}`,
					status: "published",
					data: {
						title: `Post ${i}`,
						content: portableText(i <= 5 ? "As mentioned in the roadmap." : "Other news."),
					},
				}),
			);
		}

		const result = await searchWithDb(db, "roadmap", {
			collections: ["page", "post"],
			limit: 100,
		});

		expect(result.items[0].collection).toBe("page");
		expect(result.items[0].title).toBe("Roadmap");
	});

	it("ranks title containing query above body-only matches", async () => {
		await repo.create(
			createPageFixture({
				slug: "roadmap-plan",
				status: "published",
				data: {
					title: "Our Roadmap",
					content: portableText("Plans for the future."),
				},
			}),
		);

		for (let i = 1; i <= 20; i++) {
			await repo.create(
				createPostFixture({
					slug: `post-${i}`,
					status: "published",
					data: {
						title: `Post ${i}`,
						content: portableText("Check the roadmap."),
					},
				}),
			);
		}

		const result = await searchWithDb(db, "roadmap", {
			collections: ["page", "post"],
			limit: 100,
		});

		const titleHitIndex = result.items.findIndex(
			(r) => r.collection === "page" && r.title === "Our Roadmap",
		);
		expect(titleHitIndex).toBe(0);

		const firstBodyOnlyPostIndex = result.items.findIndex((r) => r.collection === "post");
		expect(firstBodyOnlyPostIndex).toBeGreaterThan(titleHitIndex);
	});

	it("still orders exact title above title that merely contains terms", async () => {
		await repo.create(
			createPageFixture({
				slug: "roadmap-exact",
				status: "published",
				data: { title: "Roadmap", content: portableText("Body text.") },
			}),
		);
		await repo.create(
			createPageFixture({
				slug: "roadmap-contains",
				status: "published",
				data: { title: "Our Roadmap", content: portableText("Body text.") },
			}),
		);

		const result = await searchWithDb(db, "roadmap", {
			collections: ["page"],
			limit: 10,
		});

		expect(result.items[0].title).toBe("Roadmap");
		expect(result.items[1].title).toBe("Our Roadmap");
	});
	it("ranks title matches before applying limits and walks stable disjoint pages", async () => {
		await new FTSManager(db).enableSearch("page", {
			weights: { title: 0.01, content: 10 },
		});
		for (let i = 0; i < 6; i++) {
			await repo.create(
				createPageFixture({
					slug: `ranked-${i}`,
					status: "published",
					data: {
						title: i === 0 ? "Roadmap" : i === 1 ? "Our Roadmap" : `Page ${i}`,
						content: portableText(i < 2 ? "Future plans." : "roadmap ".repeat(30)),
					},
				}),
			);
		}
		await repo.create(
			createPostFixture({
				slug: "post-mention",
				status: "published",
				data: { title: "News", content: portableText("roadmap") },
			}),
		);

		const options = { collections: ["page", "post"], limit: 100 };
		const full = await searchWithDb(db, "roadmap", options);
		expect(full.items.slice(0, 2).map((item) => item.title)).toEqual(["Roadmap", "Our Roadmap"]);
		const paged = [];
		let cursor: string | undefined;
		for (let page = 0; page < 10; page++) {
			const response = await searchWithDb(db, "roadmap", { ...options, limit: 1, cursor });
			paged.push(...response.items);
			cursor = response.nextCursor;
			if (!cursor) break;
		}
		expect(cursor).toBeUndefined();
		expect(paged).toEqual(full.items);
		expect(new Set(paged.map((item) => item.id)).size).toBe(7);
		expect(full.items[0].score).toBeLessThan(1);
		expect(full.items[0]).not.toHaveProperty("titleMatchTier");
		for (const collection of options.collections) {
			const scores = full.items
				.filter((item) => item.collection === collection)
				.map((item) => item.score);
			expect(Math.max(...scores)).toBeCloseTo(1);
			expect(scores.every((score) => Number.isFinite(score) && score >= 0 && score <= 1)).toBe(
				true,
			);
		}
		const single = await searchCollection(db, "page", "roadmap");
		expect(single.items[0].title).toMatch(/^Page /);
		expect(single.items[0].score).not.toBe(1);
	});

	it.each([
		{ query: "travel and guide", title: "Travel and guide extras", bodyTitle: "Travel guide" },
		{ query: "日本語", title: "日本語の案内", bodyTitle: "News" },
		{ query: "école", title: "École", bodyTitle: "News" },
		{ query: "москва", title: "Москва", bodyTitle: "News" },
		{ query: "art", title: "Art designs", bodyTitle: "Party planning" },
		{ query: '"road map"', title: "Our road map", bodyTitle: "Road planning map" },
	])("prioritizes literal title terms for $query", async ({ query, title, bodyTitle }) => {
		await new FTSManager(db).enableSearch("page", { weights: { title: 0.01, content: 10 } });
		await repo.create(
			createPageFixture({
				slug: "title-match",
				status: "published",
				data: { title, content: portableText("Future plans.") },
			}),
		);
		await repo.create(
			createPageFixture({
				slug: "body-match",
				status: "published",
				data: {
					title: bodyTitle,
					content: portableText((query.replaceAll('"', "") + " ").repeat(20)),
				},
			}),
		);
		const response = await searchWithDb(db, query, { collections: ["page", "post"], limit: 1 });
		expect(response.items[0]?.title).toBe(title);
	});

	it("returns finite zero scores when all matching field weights are zero", async () => {
		await new FTSManager(db).enableSearch("page", { weights: { title: 0, content: 0 } });
		await repo.create(
			createPageFixture({
				slug: "zero-score",
				status: "published",
				data: { title: "Roadmap", content: portableText("roadmap") },
			}),
		);
		const response = await searchWithDb(db, "roadmap", { collections: ["page", "post"] });
		expect(response.items).toHaveLength(1);
		expect(response.items[0].score).toBe(0);
	});
	it("normalizes body-only hits when one collection has clamped IDF", async () => {
		for (const [collection, size] of [
			["page", 6],
			["post", 60],
		] as const) {
			for (let i = 0; i < size; i++) {
				await repo.create({
					type: collection,
					slug: `body-${i}`,
					status: "published",
					data: { title: `Entry ${i}`, content: portableText(i < 5 ? "roadmap" : "filler") },
				});
			}
		}
		const page = await searchCollection(db, "page", "roadmap");
		const post = await searchCollection(db, "post", "roadmap");
		expect(page.items[0].score).toBeLessThan(0.0001);
		expect(post.items[0].score).toBeGreaterThan(0.1);
		const merged = await searchWithDb(db, "roadmap", { collections: ["post", "page"] });
		expect(merged.items).toHaveLength(10);
		expect(merged.items.every((item) => item.score === 1)).toBe(true);
	});

	it.each([
		{ name: "unindexed", searchable: false, titles: ["Long title", "Longer title", "A"] },
		{ name: "Unicode", searchable: true, titles: ["😀", "😃", "A"] },
		{ name: "null", searchable: true, titles: ["😀", "A", null] },
	])(
		"paginates tied body matches consistently with $name titles",
		async ({ searchable, titles }) => {
			await new SchemaRegistry(db).updateField("page", "title", { searchable });
			await new FTSManager(db).enableSearch(
				"page",
				searchable ? { weights: { title: 0, content: 0 } } : undefined,
			);
			const ids: string[] = [];
			for (const [index, title] of titles.entries()) {
				const entry = await repo.create(
					createPageFixture({
						id: `01ARZ3NDEKTSV4RRFFQ69G5FA${index}`,
						slug: `unindexed-title-${index}`,
						status: "published",
						data: { title, content: portableText("roadmap") },
					}),
				);
				ids.push(entry.id);
			}
			const options = { collections: ["page", "post"] };
			const full = await searchWithDb(db, "roadmap", { ...options, limit: 10 });
			expect(full.items).toHaveLength(3);
			expect(new Set(full.items.map((item) => item.score)).size).toBe(1);
			expect(full.items[0]).not.toHaveProperty("titleLength");
			expect(full.items[0]).not.toHaveProperty("rawScore");
			const paged = [];
			let cursor: string | undefined;
			for (let page = 0; page < 4; page++) {
				const response = await searchWithDb(db, "roadmap", { ...options, limit: 1, cursor });
				paged.push(...response.items);
				cursor = response.nextCursor;
				if (!cursor) break;
			}
			expect(cursor).toBeUndefined();
			expect(paged).toEqual(full.items);
			expect(new Set(paged.map((item) => item.id))).toEqual(new Set(ids));
		},
	);
});
