import type { APIContext } from "astro";
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

import { POST as postWordPressMediaImport } from "../../../src/astro/routes/api/import/wordpress/media.js";
import { importMediaWithProgress } from "../../../src/astro/routes/api/import/wordpress/media.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import type { Storage } from "../../../src/storage/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function buildContext(db: Kysely<Database>, storage: Storage, stream: boolean): APIContext {
	const request = new Request("http://localhost/_emdash/api/import/wordpress/media", {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
		body: JSON.stringify({
			stream,
			attachments: [
				{ id: 1, url: "https://cdn.example.com/p.jpg", filename: "p.jpg", mimeType: "image/jpeg" },
			],
		}),
	});
	return {
		request,
		url: new URL(request.url),
		params: {},
		locals: {
			emdash: { db, storage, config: { imagePlaceholders: false } },
			user: { id: "user-1", email: "t@example.com", name: "T", role: 50 },
		},
	} as unknown as APIContext;
}

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
	it.each([false, true])(
		"forwards disabled placeholders through the %s WordPress route",
		async (stream) => {
			const storage = fakeStorage() as Storage;
			const response = await postWordPressMediaImport(buildContext(db, storage, stream));
			if (stream) await response.text();

			expect(response.status).toBe(200);
			const result = await new MediaRepository(db).findById(
				(await new MediaRepository(db).findMany({ limit: 10 })).items[0]!.id,
			);
			expect(result).toMatchObject({ width: 4, height: 4, blurhash: null, dominantColor: null });
		},
	);

	it("preserves imported dimensions when placeholders are disabled", async () => {
		const result = await importMediaWithProgress(
			[{ id: 1, url: "https://cdn.example.com/p.jpg", filename: "p.jpg", mimeType: "image/jpeg" }],
			db,
			fakeStorage() as Storage,
			() => {},
			false,
		);

		expect(result.imported).toHaveLength(1);
		const row = await new MediaRepository(db).findById(result.imported[0]!.mediaId);
		expect(row).toMatchObject({ width: 4, height: 4, blurhash: null, dominantColor: null });
	});
});
