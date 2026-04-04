import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { BylineRepository } from "../../../../src/database/repositories/byline.js";
import { ContentRepository } from "../../../../src/database/repositories/content.js";
import type { Database } from "../../../../src/database/types.js";
import { SQL_BATCH_SIZE } from "../../../../src/utils/chunks.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../../utils/test-db.js";

describe("BylineRepository", () => {
	let db: Kysely<Database>;
	let bylineRepo: BylineRepository;
	let contentRepo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		bylineRepo = new BylineRepository(db);
		contentRepo = new ContentRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("creates and reads bylines", async () => {
		const created = await bylineRepo.create({
			slug: "jane-doe",
			displayName: "Jane Doe",
			isGuest: true,
		});

		expect(created.slug).toBe("jane-doe");
		expect(created.displayName).toBe("Jane Doe");
		expect(created.isGuest).toBe(true);

		const foundById = await bylineRepo.findById(created.id);
		expect(foundById?.id).toBe(created.id);

		const foundBySlug = await bylineRepo.findBySlug("jane-doe");
		expect(foundBySlug?.id).toBe(created.id);

		const foundByUser = await bylineRepo.findByUserId("missing-user");
		expect(foundByUser).toBeNull();
	});

	it("supports updates and paginated listing", async () => {
		const alpha = await bylineRepo.create({
			slug: "alpha",
			displayName: "Alpha Writer",
			isGuest: true,
		});
		await bylineRepo.create({
			slug: "beta",
			displayName: "Beta Writer",
			isGuest: false,
		});

		const updated = await bylineRepo.update(alpha.id, {
			displayName: "Alpha Updated",
			websiteUrl: "https://example.com",
		});
		expect(updated?.displayName).toBe("Alpha Updated");
		expect(updated?.websiteUrl).toBe("https://example.com");

		const searchResult = await bylineRepo.findMany({ search: "Beta" });
		expect(searchResult.items).toHaveLength(1);
		expect(searchResult.items[0]?.slug).toBe("beta");

		const page1 = await bylineRepo.findMany({ limit: 1 });
		expect(page1.items).toHaveLength(1);
		expect(page1.nextCursor).toBeTruthy();

		const page2 = await bylineRepo.findMany({ limit: 1, cursor: page1.nextCursor });
		expect(page2.items).toHaveLength(1);
		expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);
	});

	it("assigns ordered bylines to content and syncs primary_byline_id", async () => {
		const lead = await bylineRepo.create({
			slug: "lead",
			displayName: "Lead Author",
		});
		const second = await bylineRepo.create({
			slug: "second",
			displayName: "Second Author",
		});

		const content = await contentRepo.create({
			type: "post",
			slug: "bylined-post",
			data: { title: "Bylined Post" },
		});

		const assigned = await bylineRepo.setContentBylines("post", content.id, [
			{ bylineId: lead.id },
			{ bylineId: second.id, roleLabel: "Editor" },
		]);

		expect(assigned).toHaveLength(2);
		expect(assigned[0]?.byline.id).toBe(lead.id);
		expect(assigned[0]?.sortOrder).toBe(0);
		expect(assigned[1]?.byline.id).toBe(second.id);
		expect(assigned[1]?.roleLabel).toBe("Editor");

		const refreshed = await contentRepo.findById("post", content.id);
		expect(refreshed?.primaryBylineId).toBe(lead.id);
	});

	it("reorders bylines and updates primary_byline_id", async () => {
		const first = await bylineRepo.create({
			slug: "first",
			displayName: "First",
		});
		const second = await bylineRepo.create({
			slug: "second-reorder",
			displayName: "Second",
		});

		const content = await contentRepo.create({
			type: "post",
			slug: "reordered-post",
			data: { title: "Reordered" },
		});

		await bylineRepo.setContentBylines("post", content.id, [
			{ bylineId: first.id },
			{ bylineId: second.id },
		]);

		await bylineRepo.setContentBylines("post", content.id, [
			{ bylineId: second.id },
			{ bylineId: first.id },
		]);

		const refreshed = await contentRepo.findById("post", content.id);
		expect(refreshed?.primaryBylineId).toBe(second.id);

		const bylines = await bylineRepo.getContentBylines("post", content.id);
		expect(bylines[0]?.byline.id).toBe(second.id);
		expect(bylines[1]?.byline.id).toBe(first.id);
	});

	it("getContentBylinesMany handles more IDs than SQL_BATCH_SIZE", async () => {
		const byline = await bylineRepo.create({
			slug: "batch-author",
			displayName: "Batch Author",
		});

		// Create a few real content entries with bylines
		const realIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			const content = await contentRepo.create({
				type: "post",
				slug: `batch-post-${i}`,
				data: { title: `Batch Post ${i}` },
			});
			await bylineRepo.setContentBylines("post", content.id, [{ bylineId: byline.id }]);
			realIds.push(content.id);
		}

		// Build an ID list larger than SQL_BATCH_SIZE with the real IDs spread across chunks
		const ids: string[] = [];
		for (let i = 0; i < SQL_BATCH_SIZE + 10; i++) {
			ids.push(`fake-id-${i}`);
		}
		// Place real IDs so they span different chunks
		ids[0] = realIds[0]!;
		ids[SQL_BATCH_SIZE - 1] = realIds[1]!;
		ids[SQL_BATCH_SIZE + 5] = realIds[2]!;

		const result = await bylineRepo.getContentBylinesMany("post", ids);

		// All 3 real entries should have their byline resolved
		expect(result.get(realIds[0]!)).toHaveLength(1);
		expect(result.get(realIds[1]!)).toHaveLength(1);
		expect(result.get(realIds[2]!)).toHaveLength(1);
		expect(result.get(realIds[0]!)![0]!.byline.id).toBe(byline.id);
	});

	it("findByUserIds handles more IDs than SQL_BATCH_SIZE", async () => {
		// Create a real user so the FK constraint is satisfied
		const userId = "user-batch-test";
		await db
			.insertInto("users" as any)
			.values({ id: userId, email: "batch@test.com", name: "Batch", role: 50 })
			.execute();

		const byline = await bylineRepo.create({
			slug: "user-batch",
			displayName: "User Batch",
			userId,
		});

		// Build a user ID list larger than SQL_BATCH_SIZE
		const userIds: string[] = [];
		for (let i = 0; i < SQL_BATCH_SIZE + 10; i++) {
			userIds.push(`user-fake-${i}`);
		}
		userIds[SQL_BATCH_SIZE + 5] = userId;

		const result = await bylineRepo.findByUserIds(userIds);

		expect(result.size).toBe(1);
		expect(result.get(userId)?.id).toBe(byline.id);
	});

	it("deletes byline, removes links, and nulls primary_byline_id", async () => {
		const byline = await bylineRepo.create({
			slug: "delete-me",
			displayName: "Delete Me",
		});

		const content = await contentRepo.create({
			type: "post",
			slug: "delete-byline-post",
			data: { title: "Delete Byline" },
		});

		await bylineRepo.setContentBylines("post", content.id, [{ bylineId: byline.id }]);

		const deleted = await bylineRepo.delete(byline.id);
		expect(deleted).toBe(true);

		const unresolved = await bylineRepo.getContentBylines("post", content.id);
		expect(unresolved).toHaveLength(0);

		const refreshed = await contentRepo.findById("post", content.id);
		expect(refreshed?.primaryBylineId).toBeNull();
	});
});
