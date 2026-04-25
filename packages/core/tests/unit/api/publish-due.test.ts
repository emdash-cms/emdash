import { sql, type Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate, handleContentPublishDue } from "../../../src/api/index.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

/** Set scheduled_at directly, bypassing the future-date guard in the handler. */
async function forceSchedule(
	db: Kysely<Database>,
	collection: string,
	id: string,
	scheduledAt: string,
) {
	const tableName = `ec_${collection}`;
	await sql`
		UPDATE ${sql.ref(tableName)}
		SET scheduled_at = ${scheduledAt}, status = 'scheduled'
		WHERE id = ${id}
	`.execute(db);
}

describe("handleContentPublishDue", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("returns success with zero published when no content is scheduled", async () => {
		const result = await handleContentPublishDue(db);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.published).toBe(0);
		expect(result.data.byCollection).toEqual({});
	});

	it("publishes a scheduled post whose scheduled_at is in the past", async () => {
		const created = await handleContentCreate(db, "post", {
			data: { title: "Scheduled Post" },
		});
		expect(created.success).toBe(true);
		if (!created.success) return;
		const id = created.data.item.id;

		const pastDate = new Date(Date.now() - 60_000).toISOString();
		await forceSchedule(db, "post", id, pastDate);

		const result = await handleContentPublishDue(db);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.published).toBe(1);
		expect(result.data.byCollection).toEqual({ post: 1 });
	});

	it("does not publish content scheduled for the future", async () => {
		const created = await handleContentCreate(db, "post", {
			data: { title: "Future Post" },
		});
		expect(created.success).toBe(true);
		if (!created.success) return;
		const id = created.data.item.id;

		const futureDate = new Date(Date.now() + 60_000 * 60).toISOString();
		await forceSchedule(db, "post", id, futureDate);

		const result = await handleContentPublishDue(db);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.published).toBe(0);
	});

	it("publishes multiple due items across collections", async () => {
		const post1 = await handleContentCreate(db, "post", { data: { title: "Post 1" } });
		const post2 = await handleContentCreate(db, "post", { data: { title: "Post 2" } });
		const page1 = await handleContentCreate(db, "page", { data: { title: "Page 1" } });

		expect(post1.success).toBe(true);
		expect(post2.success).toBe(true);
		expect(page1.success).toBe(true);
		if (!post1.success || !post2.success || !page1.success) return;

		const past = new Date(Date.now() - 60_000).toISOString();
		await forceSchedule(db, "post", post1.data.item.id, past);
		await forceSchedule(db, "post", post2.data.item.id, past);
		await forceSchedule(db, "page", page1.data.item.id, past);

		const result = await handleContentPublishDue(db);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.published).toBe(3);
		expect(result.data.byCollection).toEqual({ post: 2, page: 1 });
	});

	it("does not republish the same item on a second call", async () => {
		const created = await handleContentCreate(db, "post", { data: { title: "Once" } });
		expect(created.success).toBe(true);
		if (!created.success) return;
		const past = new Date(Date.now() - 60_000).toISOString();
		await forceSchedule(db, "post", created.data.item.id, past);

		await handleContentPublishDue(db);
		const second = await handleContentPublishDue(db);

		expect(second.success).toBe(true);
		if (!second.success) return;
		expect(second.data.published).toBe(0);
	});

	it("returns published items with their collections for afterPublish hook dispatch", async () => {
		const post = await handleContentCreate(db, "post", { data: { title: "Hook Test" } });
		const page = await handleContentCreate(db, "page", { data: { title: "Page Hook" } });
		expect(post.success).toBe(true);
		expect(page.success).toBe(true);
		if (!post.success || !page.success) return;

		const past = new Date(Date.now() - 60_000).toISOString();
		await forceSchedule(db, "post", post.data.item.id, past);
		await forceSchedule(db, "page", page.data.item.id, past);

		const result = await handleContentPublishDue(db);
		expect(result.success).toBe(true);
		if (!result.success) return;

		expect(result.data.published).toBe(2);
		expect(result.data.items).toHaveLength(2);

		const postItem = result.data.items.find((i) => i.collection === "post");
		const pageItem = result.data.items.find((i) => i.collection === "page");

		expect(postItem).toBeDefined();
		expect(pageItem).toBeDefined();
		expect(postItem?.item.id).toBe(post.data.item.id);
		expect(pageItem?.item.id).toBe(page.data.item.id);
		expect(postItem?.item.status).toBe("published");
		expect(pageItem?.item.status).toBe("published");
	});
});
