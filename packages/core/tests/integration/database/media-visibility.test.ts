import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("media visibility migration", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("defaults existing upload paths to public and hides private rows from general lists", async () => {
		const repo = new MediaRepository(db);
		const publicItem = await repo.create({
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			storageKey: "photo.jpg",
		});
		const privateItem = await repo.create({
			filename: "brief.pdf",
			mimeType: "application/pdf",
			storageKey: "private/brief.pdf",
			visibility: "private",
		});

		expect(publicItem.visibility).toBe("public");
		expect(privateItem.visibility).toBe("private");
		expect((await repo.findMany()).items.map((item) => item.id)).toEqual([publicItem.id]);
	});
});
