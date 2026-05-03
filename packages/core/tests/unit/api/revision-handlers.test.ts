import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
	handleRevisionList,
	handleRevisionGet,
	handleRevisionRestore,
} from "../../../src/api/index.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { Database } from "../../../src/database/types.js";
import { createPostFixture } from "../../utils/fixtures.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

describe("Revision Handlers", () => {
	let db: Kysely<Database>;
	let contentRepo: ContentRepository;
	let revisionRepo: RevisionRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		contentRepo = new ContentRepository(db);
		revisionRepo = new RevisionRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	describe("handleRevisionList", () => {
		it("should return empty list when no revisions exist", async () => {
			const content = await contentRepo.create(createPostFixture());

			const result = await handleRevisionList(db, "post", content.id, {});

			expect(result.success).toBe(true);
			expect(result.data?.items).toEqual([]);
			expect(result.data?.total).toBe(0);
		});

		it("should return revisions for a content entry", async () => {
			const content = await contentRepo.create(createPostFixture());

			// Create some revisions with small delay to ensure distinct ULIDs
			await revisionRepo.create({
				collection: "post",
				entryId: content.id,
				data: { title: "Version 1", content: "First version" },
			});
			// Small delay to ensure ULID timestamp differs
			await new Promise((resolve) => setTimeout(resolve, 2));
			await revisionRepo.create({
				collection: "post",
				entryId: content.id,
				data: { title: "Version 2", content: "Second version" },
			});

			const result = await handleRevisionList(db, "post", content.id, {});

			expect(result.success).toBe(true);
			expect(result.data?.items).toHaveLength(2);
			expect(result.data?.total).toBe(2);
			// Should be newest first
			expect(result.data?.items[0].data.title).toBe("Version 2");
			expect(result.data?.items[1].data.title).toBe("Version 1");
		});

		it("should respect limit parameter", async () => {
			const content = await contentRepo.create(createPostFixture());

			// Create 5 revisions
			for (let i = 1; i <= 5; i++) {
				await revisionRepo.create({
					collection: "post",
					entryId: content.id,
					data: { title: `Version ${i}` },
				});
			}

			const result = await handleRevisionList(db, "post", content.id, {
				limit: 3,
			});

			expect(result.success).toBe(true);
			expect(result.data?.items).toHaveLength(3);
			expect(result.data?.total).toBe(5); // Total still reflects all revisions
		});

		it("should not return revisions from other entries", async () => {
			const content1 = await contentRepo.create(createPostFixture());
			const content2 = await contentRepo.create({
				...createPostFixture(),
				slug: "another-post",
			});

			await revisionRepo.create({
				collection: "post",
				entryId: content1.id,
				data: { title: "Content 1 revision" },
			});
			await revisionRepo.create({
				collection: "post",
				entryId: content2.id,
				data: { title: "Content 2 revision" },
			});

			const result = await handleRevisionList(db, "post", content1.id, {});

			expect(result.success).toBe(true);
			expect(result.data?.items).toHaveLength(1);
			expect(result.data?.items[0].data.title).toBe("Content 1 revision");
		});
	});

	describe("handleRevisionGet", () => {
		it("should return a revision by ID", async () => {
			const content = await contentRepo.create(createPostFixture());
			const revision = await revisionRepo.create({
				collection: "post",
				entryId: content.id,
				data: { title: "Test Revision" },
			});

			const result = await handleRevisionGet(db, revision.id);

			expect(result.success).toBe(true);
			expect(result.data?.item.id).toBe(revision.id);
			expect(result.data?.item.data.title).toBe("Test Revision");
		});

		it("stores and returns createdAt as explicit UTC ISO timestamp for new revisions", async () => {
			const content = await contentRepo.create(createPostFixture());
			const revision = await revisionRepo.create({
				collection: "post",
				entryId: content.id,
				data: { title: "Timestamp test" },
			});

			const stored = await db
				.selectFrom("revisions")
				.select("created_at")
				.where("id", "=", revision.id)
				.executeTakeFirstOrThrow();

			const result = await handleRevisionGet(db, revision.id);

			expect(result.success).toBe(true);
			expect(stored.created_at).toMatch(/T/);
			expect(stored.created_at).toMatch(/Z$/);
			expect(result.data?.item.createdAt).toMatch(/Z$/);
			expect(new Date(result.data!.item.createdAt).toISOString()).toBe(result.data!.item.createdAt);
		});

		it("should return NOT_FOUND for non-existent revision", async () => {
			const result = await handleRevisionGet(db, "nonexistent-id");

			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("NOT_FOUND");
		});
	});

	describe("handleRevisionRestore", () => {
		const callerUserId = "user_caller_123";

		it("should restore content to a previous revision", async () => {
			const content = await contentRepo.create({
				...createPostFixture(),
				data: { title: "Original", content: "Original content" },
			});

			// Create a revision with the original state
			const originalRevision = await revisionRepo.create({
				collection: "post",
				entryId: content.id,
				data: { title: "Original", content: "Original content" },
			});

			// Update the content
			await contentRepo.update("post", content.id, {
				data: { title: "Updated", content: "Updated content" },
			});

			// Restore to original revision
			const result = await handleRevisionRestore(db, originalRevision.id, callerUserId);

			expect(result.success).toBe(true);
			expect(result.data?.item.data.title).toBe("Original");
			expect(result.data?.item.data.content).toBe("Original content");
		});

		it("should create a new revision when restoring", async () => {
			const content = await contentRepo.create(createPostFixture());

			const revision = await revisionRepo.create({
				collection: "post",
				entryId: content.id,
				data: { title: "To restore" },
			});

			const beforeCount = await revisionRepo.countByEntry("post", content.id);

			await handleRevisionRestore(db, revision.id, callerUserId);

			const afterCount = await revisionRepo.countByEntry("post", content.id);
			expect(afterCount).toBe(beforeCount + 1);
		});

		it("should attribute the new revision to the caller", async () => {
			const content = await contentRepo.create(createPostFixture());

			const revision = await revisionRepo.create({
				collection: "post",
				entryId: content.id,
				data: { title: "To restore" },
				authorId: "original_author",
			});

			await handleRevisionRestore(db, revision.id, callerUserId);

			// The newest revision (restore record) should be attributed to the caller
			const latestRevision = await revisionRepo.findLatest("post", content.id);
			expect(latestRevision).not.toBeNull();
			expect(latestRevision!.authorId).toBe(callerUserId);
		});

		it("should handle revision data containing _slug", async () => {
			const content = await contentRepo.create({
				...createPostFixture(),
				data: { title: "Original" },
			});

			// Revision data includes _slug (added by runtime when slug changes)
			const revision = await revisionRepo.create({
				collection: "post",
				entryId: content.id,
				data: { title: "With slug change", _slug: "new-slug" },
			});

			const result = await handleRevisionRestore(db, revision.id, callerUserId);

			expect(result.success).toBe(true);
			expect(result.data?.item.data.title).toBe("With slug change");
			expect(result.data?.item.slug).toBe("new-slug");
		});

		it("should return NOT_FOUND for non-existent revision", async () => {
			const result = await handleRevisionRestore(db, "nonexistent-id", callerUserId);

			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("NOT_FOUND");
		});
	});
});
