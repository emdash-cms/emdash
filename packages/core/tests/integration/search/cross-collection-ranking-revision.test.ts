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

describe("search cross-collection ranking revision", () => {
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

	it("returns the same first n results when limit n is smaller than the full window", async () => {
		await new FTSManager(db).enableSearch("page", {
			weights: { title: 0.01, content: 10 },
		});
		for (let i = 0; i < 6; i++) {
			await repo.create(
				createPageFixture({
					slug: `limit-${i}`,
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
				slug: "post-limit",
				status: "published",
				data: { title: "News", content: portableText("roadmap") },
			}),
		);

		const full = await searchWithDb(db, "roadmap", {
			collections: ["page", "post"],
			limit: 100,
		});

		for (const smallLimit of [3, 6, 10]) {
			const small = await searchWithDb(db, "roadmap", {
				collections: ["page", "post"],
				limit: smallLimit,
			});
			expect(small.items.map((item) => item.id)).toEqual(
				full.items.slice(0, smallLimit).map((item) => item.id),
			);
		}

		const ids: string[] = [];
		let cursor: string | undefined;
		for (let i = 0; i < 20; i++) {
			const page = await searchWithDb(db, "roadmap", {
				collections: ["page", "post"],
				limit: 10,
				cursor,
			});
			ids.push(...page.items.map((item) => item.id));
			cursor = page.nextCursor;
			if (!cursor) break;
		}
		expect(ids).toEqual(full.items.slice(0, ids.length).map((item) => item.id));
	});

	it("matches title terms as word prefixes, not arbitrary substrings", async () => {
		await repo.create(
			createPageFixture({
				slug: "ai-overview",
				status: "published",
				data: { title: "AI overview", content: portableText("Future plans.") },
			}),
		);
		await repo.create(
			createPostFixture({
				slug: "training",
				status: "published",
				data: { title: "Training", content: portableText("ai ".repeat(20)) },
			}),
		);
		await repo.create(
			createPostFixture({
				slug: "sustainability",
				status: "published",
				data: { title: "Sustainability", content: portableText("ai ".repeat(20)) },
			}),
		);

		const result = await searchWithDb(db, "ai", {
			collections: ["page", "post"],
			limit: 10,
		});

		expect(result.items[0].title).toBe("AI overview");
		expect(result.items.some((item) => item.title === "Training")).toBe(true);
		expect(result.items.some((item) => item.title === "Sustainability")).toBe(true);
	});
});
