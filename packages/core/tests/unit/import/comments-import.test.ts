/**
 * Tests for comment import from the WordPress plugin API:
 * - preserves author, date, and status
 * - threads replies (deep WP threads flatten onto the root comment)
 * - skips comments whose post was not imported
 * - idempotent re-import
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importCommentsFromPlugin, type PluginComment } from "../../../src/import/comments.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

let db: Awaited<ReturnType<typeof setupTestDatabase>>;

beforeEach(async () => {
	db = await setupTestDatabase();
});

afterEach(async () => {
	await teardownTestDatabase(db);
});

function comment(overrides: Partial<PluginComment> & { id: number }): PluginComment {
	return {
		post_id: 10,
		parent_id: null,
		author_name: "Alice",
		author_email: "alice@example.com",
		body: "Nice post!",
		date_gmt: "2020-05-01T12:00:00Z",
		status: "approved",
		...overrides,
	};
}

const contentIdMap = new Map([[10, "CONTENT1"]]);
const collectionMap = new Map([[10, "posts"]]);

describe("importCommentsFromPlugin", () => {
	it("imports comments with preserved author, date, and status", async () => {
		const result = await importCommentsFromPlugin(
			[
				comment({ id: 1 }),
				comment({ id: 2, author_name: "Bob", author_email: "bob@example.com", status: "pending" }),
			],
			db,
			contentIdMap,
			collectionMap,
		);

		expect(result.imported).toBe(2);
		expect(result.errors).toEqual([]);

		const rows = await db
			.selectFrom("_emdash_comments")
			.selectAll()
			.orderBy("created_at")
			.execute();
		expect(rows).toHaveLength(2);
		expect(rows[0]!.collection).toBe("posts");
		expect(rows[0]!.content_id).toBe("CONTENT1");
		expect(rows[0]!.author_name).toBe("Alice");
		expect(rows[0]!.created_at).toBe("2020-05-01T12:00:00.000Z");
		expect(rows[1]!.status).toBe("pending");
	});

	it("threads replies and flattens deep threads onto the root", async () => {
		await importCommentsFromPlugin(
			[
				comment({ id: 1 }),
				comment({ id: 2, parent_id: 1, date_gmt: "2020-05-02T12:00:00Z" }),
				// Reply to the reply -- deeper than EmDash's 1-level threading
				comment({ id: 3, parent_id: 2, date_gmt: "2020-05-03T12:00:00Z" }),
			],
			db,
			contentIdMap,
			collectionMap,
		);

		const rows = await db
			.selectFrom("_emdash_comments")
			.select(["id", "parent_id", "created_at"])
			.orderBy("created_at")
			.execute();
		const root = rows[0]!;
		expect(root.parent_id).toBeNull();
		// Both the reply and the reply-to-reply hang off the root
		expect(rows[1]!.parent_id).toBe(root.id);
		expect(rows[2]!.parent_id).toBe(root.id);
	});

	it("skips comments for posts that were not imported", async () => {
		const result = await importCommentsFromPlugin(
			[comment({ id: 1, post_id: 999 })],
			db,
			contentIdMap,
			collectionMap,
		);

		expect(result.imported).toBe(0);
		expect(result.skipped).toBe(1);
	});

	it("is idempotent on re-import", async () => {
		const comments = [
			comment({ id: 1 }),
			comment({ id: 2, parent_id: 1, date_gmt: "2020-05-02T12:00:00Z" }),
		];
		await importCommentsFromPlugin(comments, db, contentIdMap, collectionMap);
		const second = await importCommentsFromPlugin(comments, db, contentIdMap, collectionMap);

		expect(second.imported).toBe(0);
		expect(second.skipped).toBe(2);

		const rows = await db.selectFrom("_emdash_comments").select("id").execute();
		expect(rows).toHaveLength(2);
	});
});
