import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getCommentsWithDb } from "../../../src/comments/query.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { CommentRepository } from "../../../src/database/repositories/comment.js";
import type { Database } from "../../../src/database/types.js";
import { openNodeSqliteDatabase } from "../../../src/db/node-sqlite-compat.js";

/**
 * Create a fresh in-memory SQLite database with every executed query recorded.
 * This lets us assert the number of round trips made by `getCommentsWithDb`.
 */
function createCountingDatabase(): { db: Kysely<Database>; queries: string[] } {
	const sqlite = openNodeSqliteDatabase(":memory:");
	const queries: string[] = [];
	const db = new Kysely<Database>({
		dialect: new SqliteDialect({ database: sqlite }),
		log: (event) => {
			if (event.level === "query") queries.push(event.query.sql);
		},
	});
	return { db, queries };
}

describe("getCommentsWithDb", () => {
	let db: Kysely<Database>;
	let repo: CommentRepository;
	let queries: string[];

	beforeEach(async () => {
		const counting = createCountingDatabase();
		db = counting.db;
		queries = counting.queries;
		await runMigrations(db);
		repo = new CommentRepository(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	function approvedInput(body: string) {
		return {
			collection: "post",
			contentId: "content-1",
			authorName: "Jane",
			authorEmail: "jane@example.com",
			body,
			status: "approved" as const,
		};
	}

	it("uses one query and derives the total from the list when comments are not truncated", async () => {
		for (let i = 0; i < 3; i++) {
			await repo.create(approvedInput(`Comment ${i}`));
		}

		queries.length = 0;
		const result = await getCommentsWithDb(db, {
			collection: "post",
			contentId: "content-1",
		});

		expect(queries).toHaveLength(1);
		expect(result.items).toHaveLength(3);
		expect(result.total).toBe(3);
	});

	it("falls back to a count query when the list is truncated", async () => {
		// `findByContent` clamps the page size to 100, so 101 approved comments
		// guarantees a truncated list and a non-empty nextCursor.
		const totalComments = 101;
		for (let i = 0; i < totalComments; i++) {
			await repo.create(approvedInput(`Comment ${i}`));
		}

		queries.length = 0;
		const result = await getCommentsWithDb(db, {
			collection: "post",
			contentId: "content-1",
		});

		expect(queries).toHaveLength(2);
		expect(result.items).toHaveLength(100);
		expect(result.total).toBe(totalComments);
	});

	it("reports zero total for content with no approved comments without a count query", async () => {
		queries.length = 0;
		const result = await getCommentsWithDb(db, {
			collection: "post",
			contentId: "content-1",
		});

		expect(queries).toHaveLength(1);
		expect(result.items).toHaveLength(0);
		expect(result.total).toBe(0);
	});
});
