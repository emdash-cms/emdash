import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { searchWithDb } from "../../../src/search/query.js";
import { createPostFixture } from "../../utils/fixtures.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

/**
 * An FTS5 index is laid out as `id UNINDEXED, locale UNINDEXED, ...searchable
 * fields`, so column 2 is whichever field happens to be searchable first.
 * Asking `snippet()` for that fixed column returns the first field's text no
 * matter which field the query matched — a hit in the body came back as the
 * bare title, with no highlight, and told the reader nothing about why the
 * entry matched.
 *
 * Passing -1 lets FTS5 pick the column that actually matched. These tests pin
 * that: a body-only match must quote the body, and a title match must still
 * quote the title.
 */
describe("search snippet column selection", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		repo = new ContentRepository(db);

		const registry = new SchemaRegistry(db);
		const ftsManager = new FTSManager(db);
		// `title` is registered first, so it owns column 2 — the column the
		// snippet used to be pinned to.
		await registry.updateField("post", "title", { searchable: true });
		await registry.updateField("post", "content", { searchable: true });
		await ftsManager.enableSearch("post");

		await repo.create(
			createPostFixture({
				slug: "tour-diary",
				status: "published",
				data: {
					title: "Endless Night",
					content: [
						{
							_type: "block",
							style: "normal",
							children: [
								{
									_type: "span",
									text: "The closing track is a cover of Mustang Sally, recorded live.",
								},
							],
						},
					],
				},
			}),
		);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("quotes the body when the match is in the body, not the title", async () => {
		const { items } = await searchWithDb(db, "mustang", {
			collections: ["post"],
		});

		expect(items).toHaveLength(1);
		// Before the fix this was "Endless Night" — the title, unhighlighted,
		// because the snippet was pinned to column 2.
		expect(items[0].snippet).toContain("<mark>Mustang</mark>");
		expect(items[0].snippet).toContain("Sally");
	});

	it("still quotes the title when the match is in the title", async () => {
		const { items } = await searchWithDb(db, "endless", {
			collections: ["post"],
		});

		expect(items).toHaveLength(1);
		expect(items[0].snippet).toContain("<mark>Endless</mark>");
	});
});
