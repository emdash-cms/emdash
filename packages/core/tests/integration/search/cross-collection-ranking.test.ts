import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { searchWithDb } from "../../../src/search/query.js";
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

/**
 * Separate FTS5 tables compute bm25 from their own document frequencies, so an
 * exact title match in one collection can rank below passing mentions in another.
 * These tests pin that normalization and title-match tiers prevent that.
 */
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
						content: portableText("As mentioned in the roadmap."),
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
});
