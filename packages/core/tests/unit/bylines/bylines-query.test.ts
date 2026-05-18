import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { BylineRepository } from "../../../src/database/repositories/byline.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { UserRepository } from "../../../src/database/repositories/user.js";
import type { Database } from "../../../src/database/types.js";
import { SQL_BATCH_SIZE } from "../../../src/utils/chunks.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

// Mock the loader's getDb to return our test database
vi.mock("../../../src/loader.js", () => ({
	getDb: vi.fn(),
}));

import {
	getByline,
	getBylineBySlug,
	getEntryBylines,
	getBylinesForEntries,
} from "../../../src/bylines/index.js";
import { getDb } from "../../../src/loader.js";

describe("Byline query functions", () => {
	let db: Kysely<Database>;
	let bylineRepo: BylineRepository;
	let contentRepo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		bylineRepo = new BylineRepository(db);
		contentRepo = new ContentRepository(db);
		vi.mocked(getDb).mockResolvedValue(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		vi.restoreAllMocks();
	});

	describe("getByline", () => {
		it("returns a byline by ID", async () => {
			const created = await bylineRepo.create({
				slug: "jane-doe",
				displayName: "Jane Doe",
			});

			const result = await getByline(created.id);

			expect(result).not.toBeNull();
			expect(result?.id).toBe(created.id);
			expect(result?.displayName).toBe("Jane Doe");
			expect(result?.slug).toBe("jane-doe");
		});

		it("returns null for non-existent ID", async () => {
			const result = await getByline("non-existent");
			expect(result).toBeNull();
		});
	});

	describe("getBylineBySlug", () => {
		it("returns a byline by slug", async () => {
			await bylineRepo.create({
				slug: "john-smith",
				displayName: "John Smith",
			});

			const result = await getBylineBySlug("john-smith");

			expect(result).not.toBeNull();
			expect(result?.displayName).toBe("John Smith");
		});

		it("returns null for non-existent slug", async () => {
			const result = await getBylineBySlug("nobody");
			expect(result).toBeNull();
		});
	});

	describe("getEntryBylines", () => {
		it("returns explicit byline credits for an entry", async () => {
			const lead = await bylineRepo.create({
				slug: "lead-author",
				displayName: "Lead Author",
			});
			const editor = await bylineRepo.create({
				slug: "editor",
				displayName: "Editor",
			});

			const post = await contentRepo.create({
				type: "post",
				slug: "my-post",
				data: { title: "My Post" },
			});

			await bylineRepo.setContentBylines("post", post.id, [
				{ bylineId: lead.id },
				{ bylineId: editor.id, roleLabel: "Contributing Editor" },
			]);

			const bylines = await getEntryBylines("post", post.id);

			expect(bylines).toHaveLength(2);
			expect(bylines[0]?.byline.displayName).toBe("Lead Author");
			expect(bylines[0]?.sortOrder).toBe(0);
			expect(bylines[0]?.source).toBe("explicit");
			expect(bylines[1]?.byline.displayName).toBe("Editor");
			expect(bylines[1]?.roleLabel).toBe("Contributing Editor");
			expect(bylines[1]?.source).toBe("explicit");
		});

		it("falls back to user-linked byline when no explicit credits", async () => {
			// Create a user
			const userRepo = new UserRepository(db);
			const user = await userRepo.create({
				email: "author@example.com",
				displayName: "Author User",
				role: "editor",
			});

			// Create a byline linked to the user
			await bylineRepo.create({
				slug: "author-user",
				displayName: "Author User",
				userId: user.id,
			});

			// Create a post with this user as author, no explicit bylines
			const post = await contentRepo.create({
				type: "post",
				slug: "authored-post",
				data: { title: "Authored Post" },
				authorId: user.id,
			});

			const bylines = await getEntryBylines("post", post.id);

			expect(bylines).toHaveLength(1);
			expect(bylines[0]?.byline.displayName).toBe("Author User");
			expect(bylines[0]?.source).toBe("inferred");
			expect(bylines[0]?.roleLabel).toBeNull();
		});

		it("returns empty array when no bylines and no author fallback", async () => {
			const post = await contentRepo.create({
				type: "post",
				slug: "no-author-post",
				data: { title: "No Author" },
			});

			const bylines = await getEntryBylines("post", post.id);
			expect(bylines).toHaveLength(0);
		});
	});

	describe("getBylinesForEntries", () => {
		it("batch-fetches byline credits for multiple entries", async () => {
			const author1 = await bylineRepo.create({
				slug: "author-one",
				displayName: "Author One",
			});
			const author2 = await bylineRepo.create({
				slug: "author-two",
				displayName: "Author Two",
			});

			const post1 = await contentRepo.create({
				type: "post",
				slug: "post-1",
				data: { title: "Post 1" },
			});
			const post2 = await contentRepo.create({
				type: "post",
				slug: "post-2",
				data: { title: "Post 2" },
			});
			const post3 = await contentRepo.create({
				type: "post",
				slug: "post-3",
				data: { title: "Post 3" },
			});

			await bylineRepo.setContentBylines("post", post1.id, [{ bylineId: author1.id }]);
			await bylineRepo.setContentBylines("post", post2.id, [
				{ bylineId: author1.id },
				{ bylineId: author2.id, roleLabel: "Contributor" },
			]);
			// post3 has no bylines

			const result = await getBylinesForEntries(
				"post",
				[post1, post2, post3].map((p) => ({ id: p.id, authorId: p.authorId })),
			);

			expect(result.get(post1.id)).toHaveLength(1);
			expect(result.get(post1.id)?.[0]?.byline.displayName).toBe("Author One");
			expect(result.get(post1.id)?.[0]?.source).toBe("explicit");

			expect(result.get(post2.id)).toHaveLength(2);
			expect(result.get(post2.id)?.[0]?.byline.displayName).toBe("Author One");
			expect(result.get(post2.id)?.[1]?.byline.displayName).toBe("Author Two");
			expect(result.get(post2.id)?.[1]?.roleLabel).toBe("Contributor");

			expect(result.get(post3.id)).toHaveLength(0);
		});

		it("returns inferred bylines for entries without explicit credits", async () => {
			const userRepo = new UserRepository(db);
			const user = await userRepo.create({
				email: "batch-author@example.com",
				displayName: "Batch Author",
				role: "editor",
			});

			await bylineRepo.create({
				slug: "batch-author",
				displayName: "Batch Author",
				userId: user.id,
			});

			const post = await contentRepo.create({
				type: "post",
				slug: "batch-post",
				data: { title: "Batch Post" },
				authorId: user.id,
			});

			const result = await getBylinesForEntries("post", [{ id: post.id, authorId: post.authorId }]);

			expect(result.get(post.id)).toHaveLength(1);
			expect(result.get(post.id)?.[0]?.source).toBe("inferred");
			expect(result.get(post.id)?.[0]?.byline.displayName).toBe("Batch Author");
		});

		it("handles batches larger than SQL_BATCH_SIZE across explicit and inferred bylines", async () => {
			const userRepo = new UserRepository(db);
			const explicitByline = await bylineRepo.create({
				slug: "large-batch-explicit",
				displayName: "Large Batch Explicit",
			});

			const explicitPost1 = await contentRepo.create({
				type: "post",
				slug: "large-batch-explicit-1",
				data: { title: "Large Batch Explicit 1" },
			});
			await bylineRepo.setContentBylines("post", explicitPost1.id, [
				{ bylineId: explicitByline.id },
			]);

			const inferredPosts: { id: string; authorId: string | null }[] = [];
			for (let i = 0; i < SQL_BATCH_SIZE + 2; i++) {
				const user = await userRepo.create({
					email: `large-batch-${i}@example.com`,
					displayName: `Large Batch ${i}`,
					role: "editor",
				});

				await bylineRepo.create({
					slug: `large-batch-${i}`,
					displayName: `Large Batch ${i}`,
					userId: user.id,
				});

				const post = await contentRepo.create({
					type: "post",
					slug: `large-batch-post-${i}`,
					data: { title: `Large Batch Post ${i}` },
					authorId: user.id,
				});
				inferredPosts.push({ id: post.id, authorId: post.authorId });
			}

			const explicitPost2 = await contentRepo.create({
				type: "post",
				slug: "large-batch-explicit-2",
				data: { title: "Large Batch Explicit 2" },
			});
			await bylineRepo.setContentBylines("post", explicitPost2.id, [
				{ bylineId: explicitByline.id },
			]);

			const inferredPostIds = inferredPosts.map((p) => p.id);
			const entries = [
				{ id: explicitPost1.id, authorId: explicitPost1.authorId },
				...inferredPosts,
				{ id: explicitPost2.id, authorId: explicitPost2.authorId },
			];
			const result = await getBylinesForEntries("post", entries);

			expect(result.size).toBe(entries.length);
			expect(result.get(explicitPost1.id)?.[0]?.source).toBe("explicit");
			expect(result.get(explicitPost1.id)?.[0]?.byline.displayName).toBe("Large Batch Explicit");
			expect(result.get(explicitPost2.id)?.[0]?.source).toBe("explicit");
			expect(result.get(explicitPost2.id)?.[0]?.byline.displayName).toBe("Large Batch Explicit");
			expect(result.get(inferredPostIds[0]!)?.[0]?.source).toBe("inferred");
			expect(result.get(inferredPostIds[0]!)?.[0]?.byline.displayName).toBe("Large Batch 0");
			expect(result.get(inferredPostIds[SQL_BATCH_SIZE + 1]!)?.[0]?.source).toBe("inferred");
			expect(result.get(inferredPostIds[SQL_BATCH_SIZE + 1]!)?.[0]?.byline.displayName).toBe(
				`Large Batch ${SQL_BATCH_SIZE + 1}`,
			);
		});

		it("returns empty map for empty input", async () => {
			const result = await getBylinesForEntries("post", []);
			expect(result.size).toBe(0);
		});
	});
});
