import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleMediaUpdate } from "../../../src/api/handlers/media.js";
import { mediaUpdateBody } from "../../../src/api/schemas/media.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("media focal-point updates", () => {
	let db: Kysely<Database>;
	let mediaId: string;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const item = await new MediaRepository(db).create({
			filename: "portrait.jpg",
			mimeType: "image/jpeg",
			storageKey: "portrait.jpg",
			alt: "Original alt",
		});
		mediaId = item.id;
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it.each([
		{ focalX: 0.5 },
		{ focalX: null, focalY: 0.5 },
		{ focalX: -0.1, focalY: 0.5 },
		{ focalX: 0.5, focalY: 1.1 },
		{ focalX: Number.POSITIVE_INFINITY, focalY: 0.5 },
	])("rejects an invalid pair without applying other metadata: %j", async (input) => {
		const result = await handleMediaUpdate(db, mediaId, { ...input, alt: "Changed alt" });
		expect(result).toMatchObject({
			success: false,
			error: { code: "VALIDATION_ERROR" },
		});

		const stored = await new MediaRepository(db).findById(mediaId);
		expect(stored).toMatchObject({ alt: "Original alt", focalX: null, focalY: null });
	});

	it("accepts a complete pair and reset through the request schema", () => {
		expect(mediaUpdateBody.safeParse({ focalX: 0, focalY: 1 }).success).toBe(true);
		expect(mediaUpdateBody.safeParse({ focalX: null, focalY: null }).success).toBe(true);
		expect(mediaUpdateBody.safeParse({ focalX: 0.5 }).success).toBe(false);
	});

	it("updates a valid pair through the handler", async () => {
		const result = await handleMediaUpdate(db, mediaId, { focalX: 0.25, focalY: 0.75 });
		expect(result).toMatchObject({
			success: true,
			data: { item: { focalX: 0.25, focalY: 0.75 } },
		});
	});
});
