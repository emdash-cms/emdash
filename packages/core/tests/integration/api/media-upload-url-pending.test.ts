/** The signed-upload endpoint must not leave a pending media row behind when storage cannot pre-sign. */
import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as requestUploadUrl } from "../../../src/astro/routes/api/media/upload-url.js";
import type { DatabaseSchema } from "../../../src/database/types.js";
import { EmDashStorageError } from "../../../src/storage/types.js";
import type { Storage } from "../../../src/storage/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

/** Storage that behaves like local storage / an R2 binding: it cannot pre-sign. */
function storageThatCannotPresign(): Storage {
	return {
		getSignedUploadUrl() {
			throw new EmDashStorageError(
				"Local storage does not support signed upload URLs. Upload files directly through the API.",
				"NOT_SUPPORTED",
			);
		},
	} as unknown as Storage;
}

function callRoute(db: Kysely<DatabaseSchema>, storage: Storage) {
	const request = new Request("http://localhost:4321/_emdash/api/media/upload-url", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ filename: "photo.png", contentType: "image/png", size: 1024 }),
	});

	return requestUploadUrl({
		request,
		url: new URL(request.url),
		params: {},
		locals: {
			emdash: { db, storage, config: {} },
			user: { id: "admin-1", role: Role.ADMIN },
		},
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
	} as unknown as APIContext);
}

async function countMedia(db: Kysely<DatabaseSchema>, status: string): Promise<number> {
	const rows = await db.selectFrom("media").select("id").where("status", "=", status).execute();
	return rows.length;
}

describe("POST /_emdash/api/media/upload-url with storage that cannot pre-sign", () => {
	let db: Kysely<DatabaseSchema>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("answers 501 NOT_SUPPORTED so the client falls back to direct upload", async () => {
		const response = await callRoute(db, storageThatCannotPresign());

		expect(response.status).toBe(501);
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe("NOT_SUPPORTED");
	});

	it("does not create a pending media row", async () => {
		await callRoute(db, storageThatCannotPresign());

		expect(await countMedia(db, "pending")).toBe(0);
	});

	it("does not accumulate rows across repeated attempts", async () => {
		for (let i = 0; i < 5; i++) {
			// oxlint-disable-next-line no-await-in-loop -- sequential on purpose: the point is that repeats don't accumulate
			await callRoute(db, storageThatCannotPresign());
		}

		const all = await db.selectFrom("media").select("id").execute();
		expect(all).toHaveLength(0);
	});
});
