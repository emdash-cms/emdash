import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import { BylineRepository } from "../../src/database/repositories/byline.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import type { Database } from "../../src/database/types.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

describe("Loader revision preview", () => {
	let db: Kysely<Database>;
	let revisionRepo: RevisionRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		revisionRepo = new RevisionRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function createPublishedPost(title: string) {
		const result = await handleContentCreate(db, "post", {
			data: { title },
			status: "published",
		});
		if (!result.success) throw new Error("Failed to create post");
		return result.data!.item;
	}

	it("should return Date objects for system date fields in revision preview", async () => {
		const post = await createPublishedPost("Test Post");

		// Publish the post to set published_at
		const contentRepo = new ContentRepository(db);
		await contentRepo.publish("post", post.id);

		// Create a revision (simulating a draft edit)
		const revision = await revisionRepo.create({
			collection: "post",
			entryId: post.id,
			data: { title: "Draft Title" },
		});

		const loader = emdashLoader();
		const slug = post.slug!;
		const result = await runWithContext({ editMode: true, db }, () =>
			loader.loadEntry!({ filter: { type: "post", id: slug, revisionId: revision.id } }),
		);

		expect(result).toBeDefined();
		expect(result).not.toHaveProperty("error");
		const data = (result as { data: Record<string, unknown> }).data;

		// These must be Date objects, not ISO strings
		expect(data.createdAt).toBeInstanceOf(Date);
		expect(data.updatedAt).toBeInstanceOf(Date);
		expect(data.publishedAt).toBeInstanceOf(Date);
	});

	it("should return null for unpopulated date fields in revision preview", async () => {
		// Create a draft post (no publishedAt)
		const createResult = await handleContentCreate(db, "post", {
			data: { title: "Draft Post" },
			status: "draft",
		});
		if (!createResult.success) throw new Error("Failed to create post");
		const post = createResult.data!.item;

		const revision = await revisionRepo.create({
			collection: "post",
			entryId: post.id,
			data: { title: "Updated Draft" },
		});

		const loader = emdashLoader();
		const slug = post.slug!;
		const entry = await runWithContext({ editMode: true, db }, () =>
			loader.loadEntry!({ filter: { type: "post", id: slug, revisionId: revision.id } }),
		);

		expect(entry).toBeDefined();
		expect(entry).not.toHaveProperty("error");
		const data = (entry as { data: Record<string, unknown> }).data;

		// Draft posts have no publishedAt
		expect(data.publishedAt).toBeNull();
		// But createdAt and updatedAt should still be Date objects
		expect(data.createdAt).toBeInstanceOf(Date);
		expect(data.updatedAt).toBeInstanceOf(Date);
	});

	it("excludes unpublished posts with retained publication dates from public collection loads", async () => {
		const unpublished = await createPublishedPost("Unpublished");
		const visible = await createPublishedPost("Visible");
		const contentRepo = new ContentRepository(db);
		await contentRepo.publish("post", unpublished.id, "2020-01-01T00:00:00.000Z");
		await contentRepo.unpublish("post", unpublished.id);
		await contentRepo.publish("post", visible.id, "2021-01-01T00:00:00.000Z");

		const retained = await contentRepo.findById("post", unpublished.id);
		expect(retained).toMatchObject({
			status: "draft",
			publishedAt: "2020-01-01T00:00:00.000Z",
		});

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({ filter: { type: "post" } }),
		);

		expect(result.entries.map((entry) => entry.data.title)).toEqual(["Visible"]);
	});

	it("should use revision content fields while preserving system date types", async () => {
		const post = await createPublishedPost("Original Title");

		const revision = await revisionRepo.create({
			collection: "post",
			entryId: post.id,
			data: { title: "Revised Title" },
		});

		const loader = emdashLoader();
		const slug = post.slug!;
		const entry = await runWithContext({ editMode: true, db }, () =>
			loader.loadEntry!({ filter: { type: "post", id: slug, revisionId: revision.id } }),
		);

		expect(entry).toBeDefined();
		expect(entry).not.toHaveProperty("error");
		const data = (entry as { data: Record<string, unknown> }).data;

		// Content from revision
		expect(data.title).toBe("Revised Title");
		// System dates from content table, as Date objects
		expect(data.createdAt).toBeInstanceOf(Date);
		expect(data.updatedAt).toBeInstanceOf(Date);
	});

	it("should expose explicit bylines on revision previews", async () => {
		const post = await createPublishedPost("Original Title");
		const bylineRepo = new BylineRepository(db);
		const author = await bylineRepo.create({
			displayName: "Ada Lovelace",
			slug: "ada",
		});
		await bylineRepo.setContentBylines("post", post.id, [
			{ bylineId: author.id, roleLabel: "Author" },
		]);
		const revision = await revisionRepo.create({
			collection: "post",
			entryId: post.id,
			data: { title: "Revised Title" },
		});

		const loader = emdashLoader();
		const entry = await runWithContext({ editMode: true, db }, () =>
			loader.loadEntry!({
				filter: { type: "post", id: post.slug!, revisionId: revision.id },
			}),
		);

		expect(entry).toBeDefined();
		expect(entry).not.toHaveProperty("error");
		const data = (
			entry as {
				data: {
					bylines: Array<{ source: string; byline: { displayName: string } }>;
					byline: { displayName: string } | null;
				};
			}
		).data;
		expect(data.bylines).toHaveLength(1);
		expect(data.bylines[0]).toMatchObject({
			source: "explicit",
			byline: { displayName: "Ada Lovelace" },
		});
		expect(data.byline).toBe(data.bylines[0]!.byline);
	});
});
