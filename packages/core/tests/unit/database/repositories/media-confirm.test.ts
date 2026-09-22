import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MediaRepository } from "../../../../src/database/repositories/media.js";
import type { Database } from "../../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../../utils/test-db.js";

describe("MediaRepository.confirmUpload", () => {
	let db: Kysely<Database>;
	let repo: MediaRepository;

	beforeEach(async () => {
		db = await setupTestDatabase();
		repo = new MediaRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("persists blurhash and dominantColor when confirming a pending upload", async () => {
		const pending = await repo.createPending({
			filename: "x.jpg",
			mimeType: "image/jpeg",
			storageKey: "x.jpg",
		});

		const confirmed = await repo.confirmUpload(pending.id, {
			width: 4,
			height: 4,
			size: 100,
			blurhash: "LEHV6nWB2yk8",
			dominantColor: "rgb(255,0,0)",
		});

		expect(confirmed?.status).toBe("ready");
		expect(confirmed?.width).toBe(4);
		expect(confirmed?.blurhash).toBe("LEHV6nWB2yk8");
		expect(confirmed?.dominantColor).toBe("rgb(255,0,0)");
	});
});
