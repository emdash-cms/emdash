import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getCommentsWithDb } from "../../../src/comments/query.js";
import { CommentReactionRepository } from "../../../src/database/repositories/comment-reaction.js";
import { CommentRepository } from "../../../src/database/repositories/comment.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("CommentReactionRepository", () => {
	let db: Kysely<Database>;
	let comments: CommentRepository;
	let reactions: CommentReactionRepository;

	beforeEach(async () => {
		db = await setupTestDatabase();
		comments = new CommentRepository(db);
		reactions = new CommentReactionRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	function approvedComment(overrides: Record<string, unknown> = {}) {
		return comments.create({
			collection: "post",
			contentId: "content-1",
			authorName: "Jane",
			authorEmail: "jane@example.com",
			body: "Great post!",
			status: "approved",
			...overrides,
		});
	}

	describe("toggle", () => {
		it("adds a reaction, then removes it on a second toggle by the same voter", async () => {
			const c = await approvedComment();
			expect(await reactions.toggle({ commentId: c.id, reaction: "like", voterHash: "a" })).toEqual(
				{
					reacted: true,
				},
			);
			expect(await reactions.toggle({ commentId: c.id, reaction: "like", voterHash: "a" })).toEqual(
				{
					reacted: false,
				},
			);
		});

		it("counts each distinct voter once", async () => {
			const c = await approvedComment();
			for (const v of ["a", "b", "c"]) {
				await reactions.toggle({ commentId: c.id, reaction: "like", voterHash: v });
			}
			const counts = await reactions.countsForComments([c.id]);
			expect(counts.get(c.id)).toEqual({ like: 3 });
		});
	});

	describe("countsForComments", () => {
		it("groups counts by reaction and omits comments with none", async () => {
			const c1 = await approvedComment();
			const c2 = await approvedComment();
			await reactions.toggle({ commentId: c1.id, reaction: "like", voterHash: "a" });
			await reactions.toggle({ commentId: c1.id, reaction: "love", voterHash: "b" });

			const counts = await reactions.countsForComments([c1.id, c2.id]);
			expect(counts.get(c1.id)).toEqual({ like: 1, love: 1 });
			expect(counts.has(c2.id)).toBe(false);
		});
	});

	describe("viewerReactions", () => {
		it("returns only the given voter's reactions", async () => {
			const c = await approvedComment();
			await reactions.toggle({ commentId: c.id, reaction: "like", voterHash: "a" });
			await reactions.toggle({ commentId: c.id, reaction: "like", voterHash: "b" });

			expect((await reactions.viewerReactions([c.id], "a")).get(c.id)).toEqual(["like"]);
			expect((await reactions.viewerReactions([c.id], "z")).has(c.id)).toBe(false);
		});
	});

	describe("countRecentByVoter", () => {
		it("counts a voter's recent reactions", async () => {
			const c = await approvedComment();
			await reactions.toggle({ commentId: c.id, reaction: "like", voterHash: "a" });
			await reactions.toggle({ commentId: c.id, reaction: "love", voterHash: "a" });
			expect(await reactions.countRecentByVoter("a")).toBe(2);
			expect(await reactions.countRecentByVoter("b")).toBe(0);
		});
	});

	describe("getCommentsWithDb best-sort", () => {
		it("orders top-level comments by reaction score and attaches counts", async () => {
			const low = await approvedComment({ body: "low" });
			const high = await approvedComment({ body: "high" });
			const mid = await approvedComment({ body: "mid" });

			for (const v of ["a", "b", "c", "d", "e"]) {
				await reactions.toggle({ commentId: high.id, reaction: "like", voterHash: v });
			}
			for (const v of ["a", "b"]) {
				await reactions.toggle({ commentId: mid.id, reaction: "like", voterHash: v });
			}
			void low;

			const { items } = await getCommentsWithDb(db, {
				collection: "post",
				contentId: "content-1",
				reactions: true,
				sort: "best",
			});

			expect(items.map((c) => c.body)).toEqual(["high", "mid", "low"]);
			expect(items[0]?.reactions).toEqual({ like: 5 });
		});

		it("attaches counts without reordering under the default sort", async () => {
			const c = await approvedComment({ body: "only" });
			await reactions.toggle({ commentId: c.id, reaction: "like", voterHash: "a" });

			const { items } = await getCommentsWithDb(db, {
				collection: "post",
				contentId: "content-1",
				reactions: true,
			});

			expect(items[0]?.reactions).toEqual({ like: 1 });
		});
	});
});
