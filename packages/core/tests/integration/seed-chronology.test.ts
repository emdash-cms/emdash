import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../src/database/repositories/content.js";
import type { Database } from "../../src/database/types.js";
import { applySeed } from "../../src/seed/apply.js";
import type { SeedFile } from "../../src/seed/types.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

describe("Seed chronology (Integration)", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		repo = new ContentRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("applySeed() preserves explicit chronology when creating content", async () => {
		const createdAt = "2024-01-02T03:04:05.000Z";
		const updatedAt = "2024-02-03T04:05:06.000Z";
		const publishedAt = "2024-03-04T05:06:07.000Z";

		const seed = {
			version: "1",
			content: {
				post: [
					{
						id: "legacy-post",
						slug: "legacy-post",
						status: "published",
						createdAt,
						updatedAt,
						publishedAt,
						data: { title: "Legacy Post" },
					},
				],
			},
		} as unknown as SeedFile;

		await applySeed(db, seed, { includeContent: true });
		const post = await repo.findBySlug("post", "legacy-post");

		expect(post).not.toBeNull();
		expect(post!.createdAt).toBe(createdAt);
		expect(post!.updatedAt).toBe(updatedAt);
		expect(post!.publishedAt).toBe(publishedAt);
	});

	it("applySeed() preserves explicit chronology when updating content", async () => {
		await repo.create({
			type: "post",
			slug: "legacy-post",
			data: { title: "Old Title" },
			status: "draft",
		});

		const createdAt = "2023-01-02T03:04:05.000Z";
		const updatedAt = "2024-02-03T04:05:06.000Z";
		const publishedAt = "2024-03-04T05:06:07.000Z";

		const seed = {
			version: "1",
			content: {
				post: [
					{
						id: "legacy-post",
						slug: "legacy-post",
						status: "published",
						createdAt,
						updatedAt,
						publishedAt,
						data: { title: "Updated Title" },
					},
				],
			},
		} as unknown as SeedFile;

		const result = await applySeed(db, seed, {
			includeContent: true,
			onConflict: "update",
		});
		const post = await repo.findBySlug("post", "legacy-post");

		expect(result.content.updated).toBe(1);
		expect(post).not.toBeNull();
		expect(post!.data.title).toBe("Updated Title");
		expect(post!.createdAt).toBe(createdAt);
		expect(post!.updatedAt).toBe(updatedAt);
		expect(post!.publishedAt).toBe(publishedAt);
	});
});
