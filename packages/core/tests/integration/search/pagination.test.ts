import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { encodeCursor } from "../../../src/database/repositories/types.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { searchCollection, searchWithDb } from "../../../src/search/query.js";
import { createPostFixture } from "../../utils/fixtures.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

/**
 * `search()` / `searchCollection()` advertise keyset pagination via
 * `options.cursor` and `SearchResponse.nextCursor`. These tests pin that the
 * advertised contract actually works: a cursor walks disjoint pages that cover
 * every match exactly once, and the cursor stops at the end.
 */
describe("search pagination", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		repo = new ContentRepository(db);

		const registry = new SchemaRegistry(db);
		const ftsManager = new FTSManager(db);
		await registry.updateField("post", "title", { searchable: true });
		await ftsManager.enableSearch("post");

		// Five published posts that all match the query "report".
		for (let i = 1; i <= 5; i++) {
			await repo.create(
				createPostFixture({
					slug: `report-${i}`,
					status: "published",
					data: { title: `Quarterly report number ${i}` },
				}),
			);
		}
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("returns a nextCursor when more results exist beyond the limit", async () => {
		const page = await searchWithDb(db, "report", { collections: ["post"], limit: 2 });

		expect(page.items).toHaveLength(2);
		expect(page.nextCursor).toBeTruthy();
	});

	it("omits nextCursor on the final page", async () => {
		const page = await searchWithDb(db, "report", { collections: ["post"], limit: 10 });

		expect(page.items).toHaveLength(5);
		expect(page.nextCursor).toBeUndefined();
	});

	it("walks disjoint pages covering every match exactly once", async () => {
		const seen: string[] = [];
		let cursor: string | undefined;
		let guard = 0;

		do {
			const page: { items: { id: string }[]; nextCursor?: string } = await searchWithDb(
				db,
				"report",
				{ collections: ["post"], limit: 2, cursor },
			);
			expect(page.items.length).toBeLessThanOrEqual(2);
			seen.push(...page.items.map((r) => r.id));
			cursor = page.nextCursor;
		} while (cursor && ++guard < 10);

		expect(seen).toHaveLength(5);
		expect(new Set(seen).size).toBe(5);
	});

	it("rejects a malformed cursor instead of silently restarting", async () => {
		await expect(
			searchWithDb(db, "report", { collections: ["post"], limit: 2, cursor: "not-a-cursor" }),
		).rejects.toThrow(/Invalid pagination cursor/);
	});

	it("rejects a cursor from another endpoint even if its orderValue is numeric", async () => {
		const foreignCursor = encodeCursor("1", "content-list");

		await expect(
			searchWithDb(db, "report", { collections: ["post"], limit: 2, cursor: foreignCursor }),
		).rejects.toThrow(/Invalid pagination cursor/);
	});

	it("rejects a cursor whose offset exceeds the max search offset", async () => {
		const hugeCursor = encodeCursor("999999999", "search");

		await expect(
			searchWithDb(db, "report", { collections: ["post"], limit: 2, cursor: hugeCursor }),
		).rejects.toThrow(/Invalid pagination cursor/);
	});

	it("paginates a single-collection search the same way", async () => {
		const seen: string[] = [];
		let cursor: string | undefined;
		let guard = 0;

		do {
			const page = await searchCollection(db, "post", "report", { limit: 2, cursor });
			seen.push(...page.items.map((r) => r.id));
			cursor = page.nextCursor;
		} while (cursor && ++guard < 10);

		expect(new Set(seen).size).toBe(5);
	});
});
