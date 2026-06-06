/**
 * Tests that `applySeed()` creates a live revision for entries seeded with
 * `status: "published"`.
 *
 * Regression for #650: seeded published content was missing `live_revision_id`,
 * causing the admin UI to show "Save & Publish" instead of "Unpublish" for
 * content that was already supposed to be live.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../src/database/types.js";
import { applySeed } from "../../src/seed/apply.js";
import type { SeedFile } from "../../src/seed/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";

function seedWith(status: "draft" | "published"): SeedFile {
	return {
		version: "1",
		collections: [
			{
				slug: "posts",
				label: "Posts",
				labelSingular: "Post",
				fields: [
					{ slug: "title", label: "Title", type: "string" },
					{ slug: "body", label: "Body", type: "text" },
				],
			},
		],
		content: {
			posts: [
				{
					id: "post-1",
					slug: "hello-world",
					status,
					data: { title: "Hello World", body: "body" },
				},
			],
		},
	};
}

describe("applySeed creates live revisions for published content", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("populates live_revision_id when seed status is 'published'", async () => {
		await applySeed(db, seedWith("published"), { includeContent: true });

		const row = await db
			.selectFrom("ec_posts" as any)
			.selectAll()
			.where("slug", "=", "hello-world")
			.executeTakeFirstOrThrow();

		const r = row as Record<string, unknown>;
		expect(r.status).toBe("published");
		expect(r.live_revision_id).toBeTruthy();
		expect(r.draft_revision_id).toBeNull();
		expect(r.published_at).toBeTruthy();
	});

	it("does not create a live revision when seed status is 'draft'", async () => {
		await applySeed(db, seedWith("draft"), { includeContent: true });

		const row = await db
			.selectFrom("ec_posts" as any)
			.selectAll()
			.where("slug", "=", "hello-world")
			.executeTakeFirstOrThrow();

		const r = row as Record<string, unknown>;
		expect(r.status).toBe("draft");
		expect(r.live_revision_id).toBeNull();
	});

	it("populates live_revision_id when updating an existing entry to 'published' via onConflict: 'update'", async () => {
		// First pass: create as draft
		await applySeed(db, seedWith("draft"), { includeContent: true });

		// Second pass: same slug, now published
		await applySeed(db, seedWith("published"), {
			includeContent: true,
			onConflict: "update",
		});

		const row = await db
			.selectFrom("ec_posts" as any)
			.selectAll()
			.where("slug", "=", "hello-world")
			.executeTakeFirstOrThrow();

		const r = row as Record<string, unknown>;
		expect(r.status).toBe("published");
		expect(r.live_revision_id).toBeTruthy();
	});

	it("writes a revision row to the revisions table", async () => {
		await applySeed(db, seedWith("published"), { includeContent: true });

		const row = await db
			.selectFrom("ec_posts" as any)
			.select(["id", "live_revision_id"] as never)
			.where("slug", "=", "hello-world")
			.executeTakeFirstOrThrow();

		const r = row as { id: string; live_revision_id: string };

		const revision = await db
			.selectFrom("revisions")
			.selectAll()
			.where("id", "=", r.live_revision_id)
			.executeTakeFirstOrThrow();

		expect(revision.collection).toBe("posts");
		expect(revision.entry_id).toBe(r.id);
	});
});
