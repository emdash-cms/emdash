import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ContentRepository } from "../../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../../src/database/repositories/revision.js";
import { EmDashValidationError } from "../../../../src/database/repositories/types.js";
import type { Database } from "../../../../src/database/types.js";
import { createPostFixture, createPageFixture } from "../../../utils/fixtures.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../../utils/test-db.js";

// Regex patterns for ID validation
const ULID_FORMAT_REGEX = /^[0-9A-Z]+$/i;

describe("ContentRepository", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		repo = new ContentRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	describe("create()", () => {
		it("should create content with valid data", async () => {
			const input = createPostFixture();
			const result = await repo.create(input);

			expect(result).toBeDefined();
			expect(result.id).toBeTruthy();
			expect(result.type).toBe("post");
			expect(result.slug).toBe("hello-world");
			expect(result.status).toBe("draft");
			expect(result.data).toEqual(input.data);
		});

		it("should generate ULID for ID", async () => {
			const input = createPostFixture();
			const result = await repo.create(input);

			// ULID is 26 characters long
			expect(result.id).toHaveLength(26);
			// ULID starts with timestamp (base32) - should be alphanumeric
			expect(result.id).toMatch(ULID_FORMAT_REGEX);
		});

		it("should set default status to draft", async () => {
			const input = createPostFixture();
			delete (input as any).status;

			const result = await repo.create(input);
			expect(result.status).toBe("draft");
		});

		it("should throw validation error when type is missing", async () => {
			const input = createPostFixture();
			delete (input as any).type;

			await expect(repo.create(input)).rejects.toThrow(EmDashValidationError);
		});

		it("should allow creating content without slug", async () => {
			const input = createPostFixture();
			delete (input as any).slug;

			const result = await repo.create(input);
			expect(result.slug).toBeNull();
		});

		it("should set createdAt and updatedAt timestamps", async () => {
			const input = createPostFixture();
			const result = await repo.create(input);

			expect(result.createdAt).toBeTruthy();
			expect(result.updatedAt).toBeTruthy();
		});

		it("should persist primaryBylineId on create", async () => {
			const result = await repo.create(
				createPostFixture({
					slug: "with-primary-byline",
					primaryBylineId: "byline_1",
				}),
			);

			expect(result.primaryBylineId).toBe("byline_1");
		});
	});

	describe("findById()", () => {
		it("should return content by ID", async () => {
			const input = createPostFixture();
			const created = await repo.create(input);

			const found = await repo.findById("post", created.id);

			expect(found).toBeDefined();
			expect(found?.id).toBe(created.id);
			expect(found?.data).toEqual(created.data);
		});

		it("should return null for non-existent ID", async () => {
			const found = await repo.findById("post", "01J9FAKE0000000000000000");

			expect(found).toBeNull();
		});

		it("should exclude soft-deleted content", async () => {
			const input = createPostFixture();
			const created = await repo.create(input);
			await repo.delete("post", created.id);

			const found = await repo.findById("post", created.id);

			expect(found).toBeNull();
		});

		it("should not return content of wrong type", async () => {
			const input = createPostFixture();
			const created = await repo.create(input);

			const found = await repo.findById("page", created.id);

			expect(found).toBeNull();
		});
	});

	describe("findBySlug()", () => {
		it("should return content by slug", async () => {
			const input = createPostFixture({ slug: "test-slug" });
			const created = await repo.create(input);

			const found = await repo.findBySlug("post", "test-slug");

			expect(found).toBeDefined();
			expect(found?.id).toBe(created.id);
			expect(found?.slug).toBe("test-slug");
		});

		it("should return null for non-existent slug", async () => {
			const found = await repo.findBySlug("post", "non-existent");

			expect(found).toBeNull();
		});

		it("should not return content of wrong type", async () => {
			const input = createPostFixture({ slug: "test-slug" });
			await repo.create(input);

			const found = await repo.findBySlug("page", "test-slug");

			expect(found).toBeNull();
		});
	});

	describe("findMany()", () => {
		it("should return all content of specified type", async () => {
			await repo.create(createPostFixture({ slug: "post-1" }));
			await repo.create(createPostFixture({ slug: "post-2" }));
			await repo.create(createPageFixture({ slug: "page-1" }));

			const result = await repo.findMany("post");

			expect(result.items).toHaveLength(2);
			expect(result.items.every((item) => item.type === "post")).toBe(true);
		});

		it("should filter by status", async () => {
			await repo.create(createPostFixture({ slug: "draft", status: "draft" }));
			await repo.create(createPostFixture({ slug: "published", status: "published" }));

			const result = await repo.findMany("post", {
				where: { status: "published" },
			});

			expect(result.items).toHaveLength(1);
			expect(result.items[0].status).toBe("published");
		});

		it("should filter by authorId", async () => {
			await repo.create(createPostFixture({ slug: "author1", authorId: "user1" }));
			await repo.create(createPostFixture({ slug: "author2", authorId: "user2" }));

			const result = await repo.findMany("post", {
				where: { authorId: "user1" },
			});

			expect(result.items).toHaveLength(1);
			expect(result.items[0].authorId).toBe("user1");
		});

		it("should support cursor pagination", async () => {
			// Create multiple posts
			for (let i = 1; i <= 5; i++) {
				await repo.create(createPostFixture({ slug: `post-${i}` }));
			}

			// First page
			const page1 = await repo.findMany("post", { limit: 2 });
			expect(page1.items).toHaveLength(2);
			expect(page1.nextCursor).toBeTruthy();

			// Second page
			const page2 = await repo.findMany("post", {
				limit: 2,
				cursor: page1.nextCursor,
			});
			expect(page2.items).toHaveLength(2);
			expect(page2.nextCursor).toBeTruthy();

			// Verify no overlap
			const page1Ids = page1.items.map((i) => i.id);
			const page2Ids = page2.items.map((i) => i.id);
			expect(page1Ids).not.toContain(page2Ids[0]);
		});

		it("should support ordering", async () => {
			// Create posts with specific dates
			const post1 = await repo.create(createPostFixture({ slug: "old-post" }));
			// Wait a bit to ensure different timestamps
			await new Promise((resolve) => setTimeout(resolve, 10));
			const post2 = await repo.create(createPostFixture({ slug: "new-post" }));

			// Default order (desc by createdAt)
			const resultDesc = await repo.findMany("post", {
				orderBy: { field: "createdAt", direction: "desc" },
			});
			expect(resultDesc.items[0].id).toBe(post2.id);

			// Ascending order
			const resultAsc = await repo.findMany("post", {
				orderBy: { field: "createdAt", direction: "asc" },
			});
			expect(resultAsc.items[0].id).toBe(post1.id);
		});

		it("should respect limit", async () => {
			for (let i = 1; i <= 10; i++) {
				await repo.create(createPostFixture({ slug: `post-${i}` }));
			}

			const result = await repo.findMany("post", { limit: 5 });

			expect(result.items).toHaveLength(5);
		});

		it("should exclude soft-deleted content", async () => {
			const post1 = await repo.create(createPostFixture({ slug: "post-1" }));
			await repo.create(createPostFixture({ slug: "post-2" }));
			await repo.delete("post", post1.id);

			const result = await repo.findMany("post");

			expect(result.items).toHaveLength(1);
			expect(result.items[0].slug).toBe("post-2");
		});
	});

	describe("update()", () => {
		it("should update content data", async () => {
			const input = createPostFixture();
			const created = await repo.create(input);

			const updated = await repo.update("post", created.id, {
				data: { title: "Updated Title", content: [] },
			});

			expect(updated.data).toEqual({ title: "Updated Title", content: [] });
		});

		it("should update status", async () => {
			const input = createPostFixture();
			const created = await repo.create(input);

			const updated = await repo.update("post", created.id, {
				status: "published",
			});

			expect(updated.status).toBe("published");
		});

		it("should update slug", async () => {
			const input = createPostFixture();
			const created = await repo.create(input);

			const updated = await repo.update("post", created.id, {
				slug: "new-slug",
			});

			expect(updated.slug).toBe("new-slug");
		});

		it("should update publishedAt timestamp", async () => {
			const input = createPostFixture();
			const created = await repo.create(input);

			const publishedAt = new Date().toISOString();
			const updated = await repo.update("post", created.id, {
				publishedAt,
			});

			expect(updated.publishedAt).toBe(publishedAt);
		});

		it("should update updatedAt timestamp automatically", async () => {
			const input = createPostFixture();
			const created = await repo.create(input);

			// Wait a bit to ensure different timestamp
			await new Promise((resolve) => setTimeout(resolve, 10));

			const updated = await repo.update("post", created.id, {
				data: { title: "Updated" },
			});

			expect(updated.updatedAt).not.toBe(created.updatedAt);
		});

		it("should throw error for non-existent content", async () => {
			await expect(repo.update("post", "01J9FAKE0000000000000000", { data: {} })).rejects.toThrow(
				"Content not found",
			);
		});

		it("should update primaryBylineId", async () => {
			const created = await repo.create(
				createPostFixture({
					slug: "update-primary-byline",
					primaryBylineId: "byline_old",
				}),
			);

			const updated = await repo.update("post", created.id, {
				primaryBylineId: "byline_new",
			});

			expect(updated.primaryBylineId).toBe("byline_new");
		});
	});

	describe("delete()", () => {
		it("should soft delete content", async () => {
			const input = createPostFixture();
			const created = await repo.create(input);

			const result = await repo.delete("post", created.id);

			expect(result).toBe(true);

			// Verify content is not returned by findById
			const found = await repo.findById("post", created.id);
			expect(found).toBeNull();
		});

		it("should return false for non-existent content", async () => {
			const result = await repo.delete("post", "01J9FAKE0000000000000000");

			expect(result).toBe(false);
		});

		it("should return false when deleting already deleted content", async () => {
			const input = createPostFixture();
			const created = await repo.create(input);
			await repo.delete("post", created.id);

			const result = await repo.delete("post", created.id);

			expect(result).toBe(false);
		});
	});

	describe("count()", () => {
		it("should count all content of specified type", async () => {
			await repo.create(createPostFixture({ slug: "post-1" }));
			await repo.create(createPostFixture({ slug: "post-2" }));
			await repo.create(createPageFixture({ slug: "page-1" }));

			const count = await repo.count("post");

			expect(count).toBe(2);
		});

		it("should count with status filter", async () => {
			await repo.create(createPostFixture({ slug: "draft", status: "draft" }));
			await repo.create(createPostFixture({ slug: "published", status: "published" }));

			const count = await repo.count("post", { status: "published" });

			expect(count).toBe(1);
		});

		it("should count with authorId filter", async () => {
			await repo.create(createPostFixture({ slug: "author1", authorId: "user1" }));
			await repo.create(createPostFixture({ slug: "author2", authorId: "user2" }));

			const count = await repo.count("post", { authorId: "user1" });

			expect(count).toBe(1);
		});

		it("should exclude soft-deleted content", async () => {
			const post1 = await repo.create(createPostFixture({ slug: "post-1" }));
			await repo.create(createPostFixture({ slug: "post-2" }));
			await repo.delete("post", post1.id);

			const count = await repo.count("post");

			expect(count).toBe(1);
		});
	});

	describe("schedule()", () => {
		it("should set status to 'scheduled' for draft posts", async () => {
			const post = await repo.create(createPostFixture());
			const future = new Date(Date.now() + 86_400_000).toISOString();

			const updated = await repo.schedule("post", post.id, future);

			expect(updated.status).toBe("scheduled");
			expect(updated.scheduledAt).toBe(future);
		});

		it("should keep status 'published' for published posts", async () => {
			const post = await repo.create(createPostFixture());
			await repo.publish("post", post.id);
			const future = new Date(Date.now() + 86_400_000).toISOString();

			const updated = await repo.schedule("post", post.id, future);

			expect(updated.status).toBe("published");
			expect(updated.scheduledAt).toBe(future);
		});

		it("should reject dates in the past", async () => {
			const post = await repo.create(createPostFixture());
			const past = new Date(Date.now() - 86_400_000).toISOString();

			await expect(repo.schedule("post", post.id, past)).rejects.toThrow(EmDashValidationError);
		});

		it("should reject invalid date strings", async () => {
			const post = await repo.create(createPostFixture());

			await expect(repo.schedule("post", post.id, "not-a-date")).rejects.toThrow(
				EmDashValidationError,
			);
		});
	});

	describe("unschedule()", () => {
		it("should revert scheduled draft to 'draft'", async () => {
			const post = await repo.create(createPostFixture());
			const future = new Date(Date.now() + 86_400_000).toISOString();
			await repo.schedule("post", post.id, future);

			const updated = await repo.unschedule("post", post.id);

			expect(updated.status).toBe("draft");
			expect(updated.scheduledAt).toBeNull();
		});

		it("should keep published posts as 'published'", async () => {
			const post = await repo.create(createPostFixture());
			await repo.publish("post", post.id);
			const future = new Date(Date.now() + 86_400_000).toISOString();
			await repo.schedule("post", post.id, future);

			const updated = await repo.unschedule("post", post.id);

			expect(updated.status).toBe("published");
			expect(updated.scheduledAt).toBeNull();
		});
	});

	describe("setDraftRevision()", () => {
		it("sets the draft_revision_id so publish() picks it up", async () => {
			const post = await repo.create(createPostFixture());
			const revisionRepo = new RevisionRepository(db);
			const draft = await revisionRepo.create({
				collection: "post",
				entryId: post.id,
				data: { ...post.data, title: "Staged for publish" },
			});

			await repo.setDraftRevision("post", post.id, draft.id);

			const afterStaging = await repo.findById("post", post.id);
			expect(afterStaging?.draftRevisionId).toBe(draft.id);

			const published = await repo.publish("post", post.id);

			expect(published.liveRevisionId).toBe(draft.id);
			expect(published.draftRevisionId).toBeNull();
		});

		it("throws when the content item does not exist", async () => {
			await expect(
				repo.setDraftRevision("post", "01K0000000000000000000000", "01K0000000000000000000001"),
			).rejects.toThrow(EmDashValidationError);
		});

		it("throws when the revision does not exist", async () => {
			const post = await repo.create(createPostFixture());
			await expect(
				repo.setDraftRevision("post", post.id, "01K0000000000000000000001"),
			).rejects.toThrow(EmDashValidationError);
		});

		it("throws when the revision belongs to a different content item", async () => {
			const post1 = await repo.create(createPostFixture({ slug: "one" }));
			const post2 = await repo.create(createPostFixture({ slug: "two" }));
			const revisionRepo = new RevisionRepository(db);
			const draft = await revisionRepo.create({
				collection: "post",
				entryId: post2.id,
				data: post2.data,
			});

			await expect(repo.setDraftRevision("post", post1.id, draft.id)).rejects.toThrow(
				EmDashValidationError,
			);
		});
	});

	describe("publish() clears schedule", () => {
		it("should clear scheduled_at when publishing a scheduled draft", async () => {
			const post = await repo.create(createPostFixture());
			const future = new Date(Date.now() + 86_400_000).toISOString();
			await repo.schedule("post", post.id, future);

			const published = await repo.publish("post", post.id);

			expect(published.status).toBe("published");
			expect(published.scheduledAt).toBeNull();
		});

		it("should clear scheduled_at when publishing a published post with scheduled changes", async () => {
			const post = await repo.create(createPostFixture());
			await repo.publish("post", post.id);
			const future = new Date(Date.now() + 86_400_000).toISOString();
			await repo.schedule("post", post.id, future);

			const republished = await repo.publish("post", post.id);

			expect(republished.status).toBe("published");
			expect(republished.scheduledAt).toBeNull();
		});
	});

	describe("findReadyToPublish()", () => {
		it("should find scheduled drafts past their time", async () => {
			const post = await repo.create(createPostFixture());
			// Schedule in the past by directly updating (schedule() rejects past dates)
			const past = new Date(Date.now() - 60_000).toISOString();
			await repo.update("post", post.id, { status: "scheduled", scheduledAt: past });

			const ready = await repo.findReadyToPublish("post");

			expect(ready).toHaveLength(1);
			expect(ready[0]!.id).toBe(post.id);
		});

		it("should find published posts with past scheduled_at", async () => {
			const post = await repo.create(createPostFixture());
			await repo.publish("post", post.id);
			// Set scheduled_at in the past directly
			const past = new Date(Date.now() - 60_000).toISOString();
			await repo.update("post", post.id, { scheduledAt: past });

			const ready = await repo.findReadyToPublish("post");

			expect(ready).toHaveLength(1);
			expect(ready[0]!.id).toBe(post.id);
		});

		it("should not include items with future scheduled_at", async () => {
			const post = await repo.create(createPostFixture());
			const future = new Date(Date.now() + 86_400_000).toISOString();
			await repo.schedule("post", post.id, future);

			const ready = await repo.findReadyToPublish("post");

			expect(ready).toHaveLength(0);
		});
	});

	describe("countScheduled()", () => {
		it("should count both scheduled drafts and published posts with scheduled_at", async () => {
			// Draft with schedule
			const draft = await repo.create(createPostFixture({ slug: "draft-scheduled" }));
			const future1 = new Date(Date.now() + 86_400_000).toISOString();
			await repo.schedule("post", draft.id, future1);

			// Published with schedule
			const pub = await repo.create(createPostFixture({ slug: "pub-scheduled" }));
			await repo.publish("post", pub.id);
			const future2 = new Date(Date.now() + 172_800_000).toISOString();
			await repo.schedule("post", pub.id, future2);

			// Unscheduled draft (should not be counted)
			await repo.create(createPostFixture({ slug: "plain-draft" }));

			const count = await repo.countScheduled("post");

			expect(count).toBe(2);
		});
	});
});
