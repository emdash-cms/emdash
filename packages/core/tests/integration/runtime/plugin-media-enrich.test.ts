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
			"data.pdf",
			"application/pdf",
			new Uint8Array([1, 2, 3, 4]).buffer,
		);

		const row = await new MediaRepository(db).findById(result.mediaId);
		expect(row?.width).toBeNull();
		expect(row?.blurhash).toBeNull();
	});
});

describe("plugin ctx.media.upload — type restrictions", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("rejects a content type outside the media allowlist and stores nothing", async () => {
		const storage = fakeStorage();
		const uploads: string[] = [];
		const media = createMediaAccessWithWrite(db, undefined, {
			...storage,
			async upload(o) {
				uploads.push(o.key);
				return storage.upload(o);
			},
		});

		await expect(
			media.upload("page.html", "text/html", new TextEncoder().encode("<h1>x</h1>").buffer),
		).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE", status: 415 });
		expect(uploads).toEqual([]);
	});

	it("rejects a content type carrying a header break", async () => {
		const media = createMediaAccessWithWrite(db, undefined, fakeStorage());
		await expect(
			media.upload("a.png", "image/png\r\nX-Evil: 1", new Uint8Array([1]).buffer),
		).rejects.toMatchObject({ status: 400 });
	});

	it("rejects SVG, which can carry scripts", async () => {
		const media = createMediaAccessWithWrite(db, undefined, fakeStorage());
		await expect(
			media.upload("a.svg", "image/svg+xml", new Uint8Array([1]).buffer),
		).rejects.toMatchObject({ status: 415 });
	});

	it("stores the file under an extension that matches the checked type", async () => {
		const media = createMediaAccessWithWrite(db, undefined, fakeStorage());
		const bytes = new Uint8Array([1]).buffer;
		const jpg = await media.upload("photo.JPG", "image/jpeg", bytes);
		const disguised = await media.upload("page.html", "image/png", bytes);

		expect(jpg.storageKey).toMatch(/^[0-9A-Z]{26}\.jpg$/);
		expect(disguised.storageKey).toMatch(/^[0-9A-Z]{26}\.png$/);
	});

	it("keeps an allowed media extension when the checked type has none of its own", async () => {
		const media = createMediaAccessWithWrite(db, undefined, fakeStorage());
		const bytes = new Uint8Array([1]).buffer;
		const song = await media.upload("song.m4a", "audio/x-m4a", bytes);
		const disguised = await media.upload("page.html", "video/x-unknown", bytes);

		expect(song.storageKey).toMatch(/^[0-9A-Z]{26}\.m4a$/);
		expect(disguised.storageKey).toMatch(/^[0-9A-Z]{26}$/);
	});

	it("refuses a signed upload URL for a type outside the media allowlist", async () => {
		const media = createMediaAccessWithWrite(db, undefined, fakeStorage());

		await expect(media.getUploadUrl("page.html", "text/html")).rejects.toMatchObject({
			status: 415,
		});
		expect(await db.selectFrom("media").select("id").execute()).toEqual([]);
	});

	it("reserves a signed upload key with an extension that matches the checked type", async () => {
		const media = createMediaAccessWithWrite(db, undefined, fakeStorage());
		const { mediaId, uploadUrl } = await media.getUploadUrl("page.html", "image/png");

		const row = await new MediaRepository(db).findById(mediaId);
		expect(row?.storageKey).toMatch(/^[0-9A-Z]{26}\.png$/);
		expect(uploadUrl).toBe(`/s/${row?.storageKey}`);
	});

	it("checks the content type before calling a configured upload URL provider", async () => {
		const calls: string[] = [];
		const media = createMediaAccessWithWrite(db, async (_filename, contentType) => {
			calls.push(contentType);
			return { uploadUrl: "/u", mediaId: "m" };
		});

		await expect(media.getUploadUrl("page.html", "text/html")).rejects.toMatchObject({
			status: 415,
		});
		await media.getUploadUrl("a.png", "IMAGE/PNG");
		expect(calls).toEqual(["image/png"]);
	});
});

describe("plugin ctx.media.delete", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("removes the stored file along with the record", async () => {
		const storage = fakeStorage();
		const media = createMediaAccessWithWrite(db, undefined, storage);
		const uploaded = await media.upload(
			"data.pdf",
			"application/pdf",
			new Uint8Array([1, 2, 3, 4]).buffer,
		);
		expect(await storage.exists(uploaded.storageKey)).toBe(true);

		expect(await media.delete(uploaded.mediaId)).toBe(true);

		expect(await storage.exists(uploaded.storageKey)).toBe(false);
		expect(await new MediaRepository(db).findById(uploaded.mediaId)).toBeNull();
	});

	it("returns false for an unknown id", async () => {
		const media = createMediaAccessWithWrite(db, undefined, fakeStorage());
		expect(await media.delete("missing")).toBe(false);
	});

	it("throws when a database write fails during deletion", async () => {
		const storage = fakeStorage();
		const media = createMediaAccessWithWrite(db, undefined, storage);
		const uploaded = await media.upload(
			"data.pdf",
			"application/pdf",
			new Uint8Array([1, 2, 3, 4]).buffer,
		);
		await db.schema.dropTable("_emdash_media_upload_attempts").execute();

		await expect(media.delete(uploaded.mediaId)).rejects.toThrow("Failed to delete media");
		expect(await new MediaRepository(db).findById(uploaded.mediaId)).not.toBeNull();
		expect(await storage.exists(uploaded.storageKey)).toBe(true);
	});
});
