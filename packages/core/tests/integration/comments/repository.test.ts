import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommentRepository, type Comment } from "../../../src/database/repositories/comment.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("CommentRepository", () => {
	let db: Kysely<Database>;
	let repo: CommentRepository;

	beforeEach(async () => {
		db = await setupTestDatabase();
		repo = new CommentRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	// -------------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------------

	function makeInput(overrides: Partial<Parameters<CommentRepository["create"]>[0]> = {}) {
		return {
			collection: "post",
			contentId: "content-1",
			authorName: "Jane",
			authorEmail: "jane@example.com",
			body: "Great post!",
			...overrides,
		};
	}

	// -------------------------------------------------------------------------
	// CRUD
	// -------------------------------------------------------------------------

	describe("CRUD", () => {
		it("creates a comment and returns it with id and timestamps", async () => {
			const comment = await repo.create(makeInput());

			expect(comment.id).toBeTruthy();
			expect(comment.collection).toBe("post");
			expect(comment.contentId).toBe("content-1");
			expect(comment.authorName).toBe("Jane");
			expect(comment.authorEmail).toBe("jane@example.com");
			expect(comment.body).toBe("Great post!");
			expect(comment.status).toBe("pending");
			expect(comment.createdAt).toBeTruthy();
			expect(comment.updatedAt).toBeTruthy();
			expect(comment.parentId).toBeNull();
		});

		it("findById returns the comment", async () => {
			const created = await repo.create(makeInput());
			const found = await repo.findById(created.id);

			expect(found).not.toBeNull();
			expect(found!.id).toBe(created.id);
			expect(found!.authorName).toBe("Jane");
		});

		it("findById returns null for non-existent id", async () => {
			const found = await repo.findById("nonexistent");
			expect(found).toBeNull();
		});

		it("findByContent returns matching comments", async () => {
			await repo.create(makeInput());
			await repo.create(makeInput({ body: "Second comment" }));
			await repo.create(makeInput({ contentId: "other-content" }));

			const result = await repo.findByContent("post", "content-1");

			expect(result.items).toHaveLength(2);
			expect(result.items.every((c) => c.contentId === "content-1")).toBe(true);
		});

		it("findByStatus filters by status", async () => {
			await repo.create(makeInput({ status: "approved" }));
			await repo.create(makeInput({ status: "pending" }));
			await repo.create(makeInput({ status: "spam" }));

			const result = await repo.findByStatus("approved");
			expect(result.items).toHaveLength(1);
			expect(result.items[0]!.status).toBe("approved");
		});
	});

	// -------------------------------------------------------------------------
	// Status transitions
	// -------------------------------------------------------------------------

	describe("Status transitions", () => {
		it("applies exactly one concurrent expected-status transition", async () => {
			const created = await repo.create(makeInput({ status: "pending" }));
			const results = await Promise.all([
				repo.updateStatusIf(created.id, "approved", "pending"),
				repo.updateStatusIf(created.id, "spam", "pending"),
			]);
			expect(results.filter((result) => result.state === "updated")).toHaveLength(1);
			expect(results.filter((result) => result.state === "conflict")).toHaveLength(1);
		});

		it("does not update timestamps or report a transition for an unchanged status", async () => {
			const created = await repo.create(makeInput({ status: "pending" }));
			await expect(repo.updateStatusIf(created.id, "pending", "pending")).resolves.toEqual({
				state: "unchanged",
				comment: created,
			});
		});
		it("updateStatus changes status", async () => {
			const created = await repo.create(makeInput());
			const updated = await repo.updateStatus(created.id, "approved");

			expect(updated).not.toBeNull();
			expect(updated!.status).toBe("approved");
			expect(updated!.id).toBe(created.id);
		});

		it("bulkUpdateStatus returns count of updated rows", async () => {
			const c1 = await repo.create(makeInput());
			const c2 = await repo.create(makeInput({ body: "Second" }));

			const count = await repo.bulkUpdateStatus([c1.id, c2.id], "approved");
			expect(count).toBe(2);

			const found1 = await repo.findById(c1.id);
			const found2 = await repo.findById(c2.id);
			expect(found1!.status).toBe("approved");
			expect(found2!.status).toBe("approved");
		});

		it("bulkUpdateStatus returns 0 for empty array", async () => {
			const count = await repo.bulkUpdateStatus([], "approved");
			expect(count).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// Deletion
	// -------------------------------------------------------------------------

	describe("Deletion", () => {
		it("delete hard-deletes and returns true", async () => {
			const created = await repo.create(makeInput());
			const deleted = await repo.delete(created.id);

			expect(deleted).toBe(true);
			expect(await repo.findById(created.id)).toBeNull();
		});

		it("delete returns false for non-existent id", async () => {
			const deleted = await repo.delete("nonexistent");
			expect(deleted).toBe(false);
		});

		it("bulkDelete returns count", async () => {
			const c1 = await repo.create(makeInput());
			const c2 = await repo.create(makeInput({ body: "Second" }));

			const count = await repo.bulkDelete([c1.id, c2.id]);
			expect(count).toBe(2);
		});

		it("bulkDelete returns 0 for empty array", async () => {
			const count = await repo.bulkDelete([]);
			expect(count).toBe(0);
		});

		it("deleteByContent removes all comments for content", async () => {
			await repo.create(makeInput());
			await repo.create(makeInput({ body: "Second" }));
			await repo.create(makeInput({ contentId: "other-content" }));

			const count = await repo.deleteByContent("post", "content-1");
			expect(count).toBe(2);

			const remaining = await repo.findByContent("post", "content-1");
			expect(remaining.items).toHaveLength(0);

			const other = await repo.findByContent("post", "other-content");
			expect(other.items).toHaveLength(1);
		});

		it("parent FK cascade deletes replies", async () => {
			const parent = await repo.create(makeInput());
			const reply = await repo.create(makeInput({ parentId: parent.id, body: "Reply" }));

			await repo.delete(parent.id);

			expect(await repo.findById(parent.id)).toBeNull();
			expect(await repo.findById(reply.id)).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// Counting
	// -------------------------------------------------------------------------

	describe("Counting", () => {
		it("countByContent with and without status filter", async () => {
			await repo.create(makeInput({ status: "approved" }));
			await repo.create(makeInput({ status: "pending" }));
			await repo.create(makeInput({ status: "approved" }));

			const total = await repo.countByContent("post", "content-1");
			expect(total).toBe(3);

			const approved = await repo.countByContent("post", "content-1", "approved");
			expect(approved).toBe(2);

			const pending = await repo.countByContent("post", "content-1", "pending");
			expect(pending).toBe(1);
		});

		it("countByStatus returns grouped counts", async () => {
			await repo.create(makeInput({ status: "approved" }));
			await repo.create(makeInput({ status: "approved" }));
			await repo.create(makeInput({ status: "pending" }));
			await repo.create(makeInput({ status: "spam" }));

			const counts = await repo.countByStatus();
			expect(counts.approved).toBe(2);
			expect(counts.pending).toBe(1);
			expect(counts.spam).toBe(1);
			expect(counts.trash).toBe(0);
		});

		it("countApprovedByEmail counts only approved comments", async () => {
			await repo.create(makeInput({ status: "approved" }));
			await repo.create(makeInput({ status: "approved" }));
			await repo.create(makeInput({ status: "pending" }));

			const count = await repo.countApprovedByEmail("jane@example.com");
			expect(count).toBe(2);
		});
	});

	// -------------------------------------------------------------------------
	// Cursor pagination
	// -------------------------------------------------------------------------

	describe("Cursor pagination", () => {
		it("paginates plugin administration reads and excludes trash from list and count", async () => {
			for (let index = 0; index < 3; index++) {
				await repo.create(makeInput({ body: `Visible ${index}`, status: "pending" }));
			}
			await repo.create(makeInput({ body: "Trashed", status: "trash" }));

			const first = await repo.findForPlugin({ limit: 2 });
			expect(first.items).toHaveLength(2);
			expect(first.nextCursor).toBeTruthy();
			const second = await repo.findForPlugin({ limit: 2, cursor: first.nextCursor });
			expect(second.items).toHaveLength(1);
			await expect(repo.countForPlugin()).resolves.toBe(3);
		});
		it("findByContent paginates with cursor", async () => {
			// Create 5 comments
			for (let i = 0; i < 5; i++) {
				await repo.create(makeInput({ body: `Comment ${i}` }));
			}

			const page1 = await repo.findByContent("post", "content-1", { limit: 2 });
			expect(page1.items).toHaveLength(2);
			expect(page1.nextCursor).toBeTruthy();

			const page2 = await repo.findByContent("post", "content-1", {
				limit: 2,
				cursor: page1.nextCursor,
			});
			expect(page2.items).toHaveLength(2);
			expect(page2.nextCursor).toBeTruthy();

			const page3 = await repo.findByContent("post", "content-1", {
				limit: 2,
				cursor: page2.nextCursor,
			});
			expect(page3.items).toHaveLength(1);
			expect(page3.nextCursor).toBeUndefined();

			// Ensure no duplicates across pages
			const allIds = [...page1.items, ...page2.items, ...page3.items].map((c) => c.id);
			expect(new Set(allIds).size).toBe(5);
		});

		it("findByStatus paginates with cursor", async () => {
			for (let i = 0; i < 4; i++) {
				await repo.create(makeInput({ status: "approved", body: `Comment ${i}` }));
			}

			const page1 = await repo.findByStatus("approved", { limit: 2 });
			expect(page1.items).toHaveLength(2);
			expect(page1.nextCursor).toBeTruthy();

			const page2 = await repo.findByStatus("approved", {
				limit: 2,
				cursor: page1.nextCursor,
			});
			expect(page2.items).toHaveLength(2);
			expect(page2.nextCursor).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// Threading
	// -------------------------------------------------------------------------

	describe("Threading", () => {
		it("assembleThreads produces 1-level nesting", () => {
			const root: Comment = {
				id: "root",
				collection: "post",
				contentId: "c1",
				parentId: null,
				authorName: "A",
				authorEmail: "a@test.com",
				authorUserId: null,
				body: "Root",
				status: "approved",
				ipHash: null,
				userAgent: null,
				moderationMetadata: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			};

			const reply: Comment = {
				...root,
				id: "reply1",
				parentId: "root",
				body: "Reply",
			};

			const threads = CommentRepository.assembleThreads([root, reply]);
			expect(threads).toHaveLength(1);
			expect((threads[0] as Comment & { _replies?: Comment[] })._replies).toHaveLength(1);
		});

		it("toPublicComment strips private fields", () => {
			const comment: Comment & { _replies?: Comment[] } = {
				id: "c1",
				collection: "post",
				contentId: "content-1",
				parentId: null,
				authorName: "Jane",
				authorEmail: "jane@example.com",
				authorUserId: "user-1",
				body: "Great!",
				status: "approved",
				ipHash: "abc123",
				userAgent: "Mozilla/5.0",
				moderationMetadata: { score: 0.9 },
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			};

			const pub = CommentRepository.toPublicComment(comment);

			expect(pub.id).toBe("c1");
			expect(pub.authorName).toBe("Jane");
			expect(pub.isRegisteredUser).toBe(true);
			expect(pub.body).toBe("Great!");
			expect(pub.createdAt).toBe("2026-01-01T00:00:00.000Z");

			// Private fields should not be present
			expect("authorEmail" in pub).toBe(false);
			expect("ipHash" in pub).toBe(false);
			expect("userAgent" in pub).toBe(false);
			expect("moderationMetadata" in pub).toBe(false);
			expect("status" in pub).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// Edge cases
	// -------------------------------------------------------------------------

	describe("Edge cases", () => {
		it("returns empty results for non-existent content", async () => {
			const result = await repo.findByContent("post", "nonexistent");
			expect(result.items).toHaveLength(0);
			expect(result.nextCursor).toBeUndefined();
		});

		it("moderationMetadata JSON round-trips correctly", async () => {
			const metadata = {
				aiScore: 0.95,
				categories: ["safe"],
				nested: { key: "value" },
			};

			const created = await repo.create(makeInput({ moderationMetadata: metadata }));

			const found = await repo.findById(created.id);
			expect(found!.moderationMetadata).toEqual(metadata);
		});

		it("moderationMetadata null round-trips", async () => {
			const created = await repo.create(makeInput());
			const found = await repo.findById(created.id);
			expect(found!.moderationMetadata).toBeNull();
		});

		it("findByStatus with search filters by body", async () => {
			await repo.create(makeInput({ status: "approved", body: "Hello world" }));
			await repo.create(makeInput({ status: "approved", body: "Goodbye world" }));

			const result = await repo.findByStatus("approved", { search: "Hello" });
			expect(result.items).toHaveLength(1);
			expect(result.items[0]!.body).toBe("Hello world");
		});

		it("findByStatus with search filters by author name", async () => {
			await repo.create(makeInput({ status: "approved", authorName: "Alice" }));
			await repo.create(makeInput({ status: "approved", authorName: "Bob" }));

			const result = await repo.findByStatus("approved", { search: "Alice" });
			expect(result.items).toHaveLength(1);
			expect(result.items[0]!.authorName).toBe("Alice");
		});

		it("findByContent with status filter", async () => {
			await repo.create(makeInput({ status: "approved" }));
			await repo.create(makeInput({ status: "pending" }));

			const result = await repo.findByContent("post", "content-1", { status: "approved" });
			expect(result.items).toHaveLength(1);
			expect(result.items[0]!.status).toBe("approved");
		});

		it("updateModerationMetadata updates the JSON field", async () => {
			const created = await repo.create(makeInput());
			await repo.updateModerationMetadata(created.id, { score: 0.5 });

			const found = await repo.findById(created.id);
			expect(found!.moderationMetadata).toEqual({ score: 0.5 });
		});
	});
});
