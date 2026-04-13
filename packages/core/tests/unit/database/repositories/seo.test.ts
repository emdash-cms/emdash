import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ContentRepository } from "../../../../src/database/repositories/content.js";
import { SeoRepository } from "../../../../src/database/repositories/seo.js";
import type { Database } from "../../../../src/database/types.js";
import { SQL_BATCH_SIZE } from "../../../../src/utils/chunks.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../../utils/test-db.js";

describe("SeoRepository", () => {
	let db: Kysely<Database>;
	let seoRepo: SeoRepository;
	let contentRepo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		// Enable SEO on the post collection — createCollection defaults has_seo to 0.
		await db
			.updateTable("_emdash_collections")
			.set({ has_seo: 1 })
			.where("slug", "=", "post")
			.execute();
		seoRepo = new SeoRepository(db);
		contentRepo = new ContentRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("getMany handles more IDs than SQL_BATCH_SIZE", async () => {
		// Create a few real content entries with SEO rows
		const realIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			const content = await contentRepo.create({
				type: "post",
				slug: `seo-batch-post-${i}`,
				data: { title: `SEO Batch Post ${i}` },
			});
			await seoRepo.upsert("post", content.id, {
				title: `SEO Title ${i}`,
				description: `SEO Description ${i}`,
			});
			realIds.push(content.id);
		}

		// Build an ID list larger than SQL_BATCH_SIZE with real IDs spread across chunks
		const ids: string[] = [];
		for (let i = 0; i < SQL_BATCH_SIZE + 10; i++) {
			ids.push(`fake-id-${i}`);
		}
		ids[0] = realIds[0]!;
		ids[SQL_BATCH_SIZE - 1] = realIds[1]!;
		ids[SQL_BATCH_SIZE + 5] = realIds[2]!;

		const result = await seoRepo.getMany("post", ids);

		// All input IDs should be present in the result Map
		expect(result.size).toBe(ids.length);

		// Real IDs should have their SEO data resolved
		expect(result.get(realIds[0]!)?.title).toBe("SEO Title 0");
		expect(result.get(realIds[1]!)?.title).toBe("SEO Title 1");
		expect(result.get(realIds[2]!)?.title).toBe("SEO Title 2");

		// Fake IDs should get default values
		expect(result.get("fake-id-5")?.title).toBeNull();
		expect(result.get("fake-id-5")?.description).toBeNull();
		expect(result.get("fake-id-5")?.noIndex).toBe(false);
	});

	it("getMany returns defaults for every input id when no rows exist", async () => {
		const ids: string[] = [];
		for (let i = 0; i < SQL_BATCH_SIZE + 10; i++) {
			ids.push(`missing-id-${i}`);
		}

		const result = await seoRepo.getMany("post", ids);

		expect(result.size).toBe(ids.length);
		for (const id of ids) {
			const entry = result.get(id);
			expect(entry).toBeDefined();
			expect(entry?.title).toBeNull();
			expect(entry?.description).toBeNull();
			expect(entry?.image).toBeNull();
			expect(entry?.canonical).toBeNull();
			expect(entry?.noIndex).toBe(false);
		}
	});

	it("getMany deduplicates repeated content IDs without duplicate rows", async () => {
		const content = await contentRepo.create({
			type: "post",
			slug: "seo-duplicate-post",
			data: { title: "SEO Duplicate" },
		});
		await seoRepo.upsert("post", content.id, {
			title: "Duplicate SEO",
		});

		const ids: string[] = [];
		for (let i = 0; i < SQL_BATCH_SIZE + 10; i++) {
			ids.push(`fake-id-${i}`);
		}
		ids[0] = content.id;
		ids[SQL_BATCH_SIZE + 5] = content.id;

		const result = await seoRepo.getMany("post", ids);

		// The real entry should resolve to its SEO row regardless of the duplicate input
		expect(result.get(content.id)?.title).toBe("Duplicate SEO");
	});
});
