import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { JPEG } = vi.hoisted(() => ({
	JPEG: new Uint8Array(
		Buffer.from(
			"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAEAAQDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==",
			"base64",
		),
	),
}));

vi.mock("#import/ssrf.js", () => ({
	validateExternalUrl: () => {},
	SsrfError: class SsrfError extends Error {},
	ssrfSafeFetch: async () =>
		new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } }),
}));

import { importMediaWithProgress } from "../../../src/astro/routes/api/import/wordpress/media.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import type { Storage } from "../../../src/storage/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function fakeStorage(): Pick<Storage, "upload"> {
	return {
		async upload(o) {
			const b = o.body instanceof Uint8Array ? o.body : new Uint8Array(o.body as ArrayBuffer);
			return { key: o.key, url: `/m/${o.key}`, size: b.byteLength };
		},
	};
}

describe("WordPress import — media enrichment", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		vi.restoreAllMocks();
	});

	it("enriches imported images with dimensions and placeholders", async () => {
		const result = await importMediaWithProgress(
			[{ id: 1, url: "https://cdn.example.com/p.jpg", filename: "p.jpg", mimeType: "image/jpeg" }],
			db,
			fakeStorage() as Storage,
			() => {},
		);

		expect(result.imported).toHaveLength(1);
		const row = await new MediaRepository(db).findById(result.imported[0]!.mediaId);
		expect(row?.width).toBe(4);
		expect(row?.height).toBe(4);
		expect(row?.blurhash).toBeTruthy();
	});
});
