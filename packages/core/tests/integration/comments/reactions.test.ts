import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	handleReactionCounts,
	handleReactionToggle,
} from "../../../src/api/handlers/comment-reactions.js";
import { getCommentsWithDb } from "../../../src/comments/query.js";
import { CommentReactionRepository } from "../../../src/database/repositories/comment-reaction.js";
import { CommentRepository } from "../../../src/database/repositories/comment.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

describe("CommentReactionRepository", () => {
	let db: Kysely<Database>;
	let comments: CommentRepository;
	let reactions: CommentReactionRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
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

	function publishEntry() {
		return new ContentRepository(db).create({
			id: "content-1",
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			status: "published",
			publishedAt: new Date().toISOString(),
		});
	}

	describe("handleReactionToggle", () => {
		const base = { collection: "post", contentId: "content-1" };

		beforeEach(async () => {
			await publishEntry();
		});

		it("toggles a reaction and returns updated counts", async () => {
			const c = await approvedComment();
			const r = await handleReactionToggle(db, {
				...base,
				commentId: c.id,
				reaction: "like",
				voterHash: "v1",
			});
			expect(r.success).toBe(true);
			if (r.success) {
				expect(r.data.reacted).toBe(true);
				expect(r.data.counts).toEqual({ like: 1 });
			}
		});

		it("rejects an unsupported reaction with VALIDATION_ERROR", async () => {
			const c = await approvedComment();
			const r = await handleReactionToggle(db, {
				...base,
				commentId: c.id,
				reaction: "spam",
				voterHash: "v1",
			});
			expect(r.success).toBe(false);
			if (!r.success) expect(r.error.code).toBe("VALIDATION_ERROR");
		});

		it("rejects reacting to a non-approved comment", async () => {
			const c = await approvedComment({ status: "pending" });
			const r = await handleReactionToggle(db, {
				...base,
				commentId: c.id,
				reaction: "like",
				voterHash: "v1",
			});
			expect(r.success).toBe(false);
			if (!r.success) expect(r.error.code).toBe("COMMENT_NOT_APPROVED");
		});

		it("rejects reacting to a missing comment", async () => {
			const r = await handleReactionToggle(db, {
				...base,
				commentId: "does-not-exist",
				reaction: "like",
				voterHash: "v1",
			});
			expect(r.success).toBe(false);
			if (!r.success) expect(r.error.code).toBe("NOT_FOUND");
		});

		it("does not error when two toggles for the same voter race (idempotent add)", async () => {
			const c = await approvedComment();
			// Fire both concurrently — the old read-then-write path could throw a
			// unique-constraint 500 here; ON CONFLICT makes it safe.
			const [a, b] = await Promise.all([
				handleReactionToggle(db, { ...base, commentId: c.id, reaction: "like", voterHash: "v1" }),
				handleReactionToggle(db, { ...base, commentId: c.id, reaction: "like", voterHash: "v1" }),
			]);
			expect(a.success).toBe(true);
			expect(b.success).toBe(true);
			// Invariant: never more than one row for the same (comment, voter, reaction).
			const counts = await reactions.countsForComments([c.id]);
			expect((counts.get(c.id)?.like ?? 0) <= 1).toBe(true);
		});

		it("rejects reacting to a comment on an unpublished or trashed entry", async () => {
			const c = await approvedComment();
			const content = new ContentRepository(db);
			const toggle = () =>
				handleReactionToggle(db, { ...base, commentId: c.id, reaction: "like", voterHash: "v1" });

			await content.unpublish("post", "content-1");
			const unpublished = await toggle();
			expect(unpublished.success).toBe(false);
			if (!unpublished.success) expect(unpublished.error.code).toBe("NOT_FOUND");

			await content.delete("post", "content-1");
			const trashed = await toggle();
			expect(trashed.success).toBe(false);
			if (!trashed.success) expect(trashed.error.code).toBe("NOT_FOUND");

			expect((await reactions.countsForComments([c.id])).has(c.id)).toBe(false);
		});

		it("answers NOT_FOUND for a collection that does not exist", async () => {
			const r = await handleReactionToggle(db, {
				collection: "missing",
				contentId: "content-1",
				commentId: "does-not-exist",
				reaction: "like",
				voterHash: "v1",
			});
			expect(r.success).toBe(false);
			if (!r.success) expect(r.error.code).toBe("NOT_FOUND");
		});
	});

	describe("handleReactionCounts", () => {
		beforeEach(async () => {
			await publishEntry();
		});

		it("returns counts and the viewer's reactions for a published entry", async () => {
			const c = await approvedComment();
			await reactions.toggle({ commentId: c.id, reaction: "like", voterHash: "v1" });

			const r = await handleReactionCounts(db, "post", "content-1", "v1");
			expect(r).toEqual({
				success: true,
				data: { reactions: { [c.id]: { like: 1 } }, viewer: { [c.id]: ["like"] } },
			});
		});

		it("returns nothing for an unpublished or trashed entry", async () => {
			const c = await approvedComment();
			await reactions.toggle({ commentId: c.id, reaction: "like", voterHash: "v1" });
			const content = new ContentRepository(db);
			const empty = { success: true, data: { reactions: {}, viewer: {} } };

			await content.unpublish("post", "content-1");
			expect(await handleReactionCounts(db, "post", "content-1", "v1")).toEqual(empty);

			await content.delete("post", "content-1");
			expect(await handleReactionCounts(db, "post", "content-1", "v1")).toEqual(empty);
		});

		it("returns nothing for a collection that does not exist", async () => {
			expect(await handleReactionCounts(db, "missing", "content-1")).toEqual({
				success: true,
				data: { reactions: {} },
			});
		});
	});
});
