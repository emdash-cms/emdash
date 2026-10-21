import { sql, type Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import type { Database } from "../../src/database/types.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

describe("Cache hints", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function createPublishedPost(title: string) {
		const result = await handleContentCreate(db, "post", {
			data: { title },
			status: "published",
		});
		if (!result.success) throw new Error("Failed to create post");
		return result.data!.item;
	}

	describe("loadCollection cacheHint", () => {
		it("should tag collection with type name", async () => {
			await createPublishedPost("First Post");
			await createPublishedPost("Second Post");

			const loader = emdashLoader();
			const result = await runWithContext({ editMode: false, db }, () =>
				loader.loadCollection!({ filter: { type: "post" } }),
			);

			expect(result.cacheHint).toBeDefined();
			expect(result.cacheHint!.tags).toEqual(["post"]);
		});

		it("should not include lastModified on a collection hint", async () => {
			// Collection/list hints must not emit a validator: deleting or unpublishing
			// an entry changes the list but does not advance max(updated_at), so a
			// conditional refresh after a missed purge would answer 304 and freeze
			// the stale body indefinitely.
			await createPublishedPost("First Post");
			await createPublishedPost("Second Post");

			const loader = emdashLoader();
			const result = await runWithContext({ editMode: false, db }, () =>
				loader.loadCollection!({ filter: { type: "post" } }),
			);

			expect(result.cacheHint!.lastModified).toBeUndefined();
		});
	});

	describe("entry-level cacheHint", () => {
		it("should tag each entry with its database ID", async () => {
			const post = await createPublishedPost("Test Post");

			const loader = emdashLoader();
			const result = await runWithContext({ editMode: false, db }, () =>
				loader.loadCollection!({ filter: { type: "post" } }),
			);

			expect(result.entries).toHaveLength(1);
			const entry = result.entries![0];
			expect(entry.cacheHint).toBeDefined();
			expect(entry.cacheHint!.tags).toEqual([post.id]);
		});

		it("should include lastModified on each entry", async () => {
			await createPublishedPost("Test Post");

			const loader = emdashLoader();
			const result = await runWithContext({ editMode: false, db }, () =>
				loader.loadCollection!({ filter: { type: "post" } }),
			);

			const entry = result.entries![0];
			expect(entry.cacheHint!.lastModified).toBeInstanceOf(Date);
		});
	});

	describe("detail pages with related content", () => {
		it("keeps collection-level validators off even when the entry has one", async () => {
			const main = await createPublishedPost("Main Post");
			const related = await handleContentCreate(db, "page", {
				data: { title: "Related Post" },
				status: "published",
			});
			if (!related.success) throw new Error("Failed to create related post");

			const loader = emdashLoader();
			const initial = await runWithContext({ editMode: false, db }, async () => ({
				entry: await loader.loadEntry!({ filter: { type: "post", id: main.slug } }),
				related: await loader.loadCollection!({
					filter: { type: "page", status: "published" },
				}),
			}));
			expect(initial.entry?.cacheHint.lastModified).toBeInstanceOf(Date);
			expect(initial.related.cacheHint?.lastModified).toBeUndefined();
			expect(initial.related.entries).toHaveLength(1);

			const mainBefore = await sql<{ updated_at: string }>`
				SELECT updated_at FROM ec_post WHERE id = ${main.id}
			`.execute(db);
			await sql`UPDATE ec_page SET status = 'draft' WHERE id = ${related.data!.item.id}`.execute(
				db,
			);
			const mainAfter = await sql<{ updated_at: string }>`
				SELECT updated_at FROM ec_post WHERE id = ${main.id}
			`.execute(db);
			expect(mainAfter.rows[0]?.updated_at).toBe(mainBefore.rows[0]?.updated_at);

			const refreshed = await runWithContext({ editMode: false, db }, () =>
				loader.loadCollection!({ filter: { type: "page", status: "published" } }),
			);
			expect(refreshed.entries).toHaveLength(0);
			expect(refreshed.cacheHint?.lastModified).toBeUndefined();
		});
	});

	describe("loadEntry cacheHint", () => {
		it("should tag entry with its database ID", async () => {
			const post = await createPublishedPost("Test Post");

			const loader = emdashLoader();
			const result = await runWithContext({ editMode: false, db }, () =>
				loader.loadEntry!({ filter: { type: "post", id: post.slug } }),
			);

			// loadEntry returns the entry directly (LiveDataEntry), not { entry, cacheHint }
			expect(result).toBeDefined();
			expect(result!.cacheHint).toBeDefined();
			expect(result!.cacheHint!.tags).toEqual([post.id]);
		});
	});

	describe("invalidation tag alignment", () => {
		it("should produce tags that match the invalidation pattern", async () => {
			const post = await createPublishedPost("Test Post");

			const loader = emdashLoader();
			const collectionResult = await runWithContext({ editMode: false, db }, () =>
				loader.loadCollection!({ filter: { type: "post" } }),
			);

			// The route invalidates with tags: [collection, id]
			// Collection pages are tagged with [type] -> matches "collection" tag
			// Entry pages are tagged with [entryId] -> matches "id" tag
			const invalidationTags = ["post", post.id];

			// Collection-level tag should be hit by invalidation
			expect(invalidationTags).toContain(collectionResult.cacheHint!.tags![0]);

			// Entry-level tag should be hit by invalidation
			const entry = collectionResult.entries![0];
			expect(invalidationTags).toContain(entry.cacheHint!.tags![0]);
		});
	});
});
