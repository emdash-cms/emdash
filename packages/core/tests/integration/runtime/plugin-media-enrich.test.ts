import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { createMediaAccessWithWrite } from "../../../src/plugins/context.js";
import type { Storage } from "../../../src/storage/types.js";
import { JPEG_4x4 } from "../../utils/image-fixtures.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function fakeStorage(): Storage {
	const store = new Map<string, Uint8Array>();
	return {
		async upload(o) {
			const b = o.body instanceof Uint8Array ? o.body : new Uint8Array(o.body as ArrayBuffer);
			store.set(o.key, b);
			return { key: o.key, url: `/m/${o.key}`, size: b.byteLength };
		},
		async download(key) {
			const b = store.get(key) ?? new Uint8Array();
			return {
				body: new Response(b).body as ReadableStream<Uint8Array>,
				contentType: "application/octet-stream",
				size: b.byteLength,
			};
		},
		async delete(key) {
			store.delete(key);
		},
		async exists(key) {
			return store.has(key);
		},
		async list() {
			return { files: [] };
		},
		async getSignedUploadUrl(o) {
			return {
				url: `/s/${o.key}`,
				method: "PUT",
				headers: {},
				expiresAt: new Date().toISOString(),
			};
		},
		getPublicUrl(key) {
			return `/m/${key}`;
		},
	};
}

describe("plugin ctx.media.upload — metadata enrichment", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("populates width, height, blurhash and dominantColor for an image upload", async () => {
		const media = createMediaAccessWithWrite(db, undefined, fakeStorage());
		const ab = JPEG_4x4.slice().buffer; // clean ArrayBuffer copy
		const result = await media.upload("derived.jpg", "image/jpeg", ab);

		const row = await new MediaRepository(db).findById(result.mediaId);
		expect(row?.width).toBe(4);
		expect(row?.height).toBe(4);
		expect(row?.blurhash).toBeTruthy();
		expect(row?.dominantColor).toMatch(/^rgb\(/);
	});

	it("leaves metadata null for a non-image upload without throwing", async () => {
		const media = createMediaAccessWithWrite(db, undefined, fakeStorage());
		const result = await media.upload(
			"data.bin",
			"application/octet-stream",
			new Uint8Array([1, 2, 3, 4]).buffer,
		);

		const row = await new MediaRepository(db).findById(result.mediaId);
		expect(row?.width).toBeNull();
		expect(row?.blurhash).toBeNull();
	});
});
