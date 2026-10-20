import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { GET } from "../../../src/astro/routes/api/media/file/[...key].js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import { LocalStorage } from "../../../src/storage/local.js";
import type { Storage } from "../../../src/storage/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const MEDIA_ID = "01J00000000000000000000000";
const CONTENT = "media content";

function request(
	key: string,
	storage: Pick<Storage, "download">,
	db: DialectTestContext["db"],
	init: RequestInit = {},
) {
	return GET({
		params: { key },
		locals: { emdash: { storage, db } },
		request: new Request(`https://example.com/_emdash/api/media/file/${key}`, init),
	} as never);
}

describeEachDialect("media file route resolves media IDs", (dialect) => {
	let ctx: DialectTestContext;
	let directory: string;
	let storage: LocalStorage;
	let repo: MediaRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		directory = await mkdtemp(join(tmpdir(), "emdash-media-file-id-"));
		storage = new LocalStorage({ directory, baseUrl: "/_emdash/api/media/file" });
		repo = new MediaRepository(ctx.db);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownForDialect(ctx);
		await rm(directory, { recursive: true, force: true });
	});

	it("serves a bare media ID using the ready row's filename key, including ranges and HEAD", async () => {
		const media = await repo.create({
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			storageKey: `${MEDIA_ID}.jpg`,
			size: CONTENT.length,
		});
		await storage.upload({
			key: media.storageKey,
			body: new TextEncoder().encode(CONTENT),
			contentType: "image/jpeg",
		});

		const full = await request(media.id, storage, ctx.db);
		expect(full.status).toBe(200);
		expect(full.headers.get("Content-Type")).toBe("image/jpeg");
		expect(full.headers.get("Content-Disposition")).toBe("inline");
		expect(await full.text()).toBe(CONTENT);

		const ranged = await request(media.id, storage, ctx.db, { headers: { Range: "bytes=0-4" } });
		expect(ranged.status).toBe(206);
		expect(ranged.headers.get("Content-Range")).toBe("bytes 0-4/13");
		expect(await ranged.text()).toBe("media");

		const head = await request(media.id, storage, ctx.db, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.headers.get("Content-Length")).toBe(String(CONTENT.length));
		expect(await head.text()).toBe("");
	});

	it("returns 404 for an unknown ID and for a row whose object is missing", async () => {
		const missing = await request(MEDIA_ID, storage, ctx.db);
		expect(missing.status).toBe(404);

		const media = await repo.create({
			filename: "missing.jpg",
			mimeType: "image/jpeg",
			storageKey: "missing.jpg",
		});
		const response = await request(media.id, storage, ctx.db);
		expect(response.status).toBe(404);
	});

	it.each(["pending", "failed"] as const)("does not serve %s media", async (status) => {
		const media = await repo.create({
			filename: `${status}.jpg`,
			mimeType: "image/jpeg",
			storageKey: `${status}.jpg`,
			status,
		});
		await storage.upload({
			key: media.storageKey,
			body: new TextEncoder().encode(CONTENT),
			contentType: "image/jpeg",
		});

		const response = await request(media.id, storage, ctx.db);
		expect(response.status).toBe(404);
	});

	it.each([
		"backups/site.zip",
		"transfers/imports/01J00000000000000000000000-secret/file.jpg",
		"transfers%2Fimports%2F01J00000000000000000000000-secret%2Ffile.jpg",
	])("refuses resolved private storage key %s even when stored", async (storageKey) => {
		const media = await repo.create({
			filename: "private.jpg",
			mimeType: "image/jpeg",
			storageKey,
		});
		await storage.upload({
			key: storageKey,
			body: new TextEncoder().encode(CONTENT),
			contentType: "image/jpeg",
		});

		const response = await request(media.id, storage, ctx.db);
		expect(response.status).toBe(404);
	});

	it("prefers a directly addressed object over the media row", async () => {
		const media = await repo.create({
			filename: "other.jpg",
			mimeType: "image/jpeg",
			storageKey: "other.jpg",
		});
		await storage.upload({
			key: media.id,
			body: new TextEncoder().encode("direct content"),
			contentType: "text/plain",
		});
		const findById = vi.spyOn(MediaRepository.prototype, "findById");

		const response = await request(media.id, storage, ctx.db);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("direct content");
		expect(findById).not.toHaveBeenCalled();
		findById.mockRestore();
	});

	it("does not query media for a missing non-ULID key", async () => {
		const findById = vi.spyOn(MediaRepository.prototype, "findById");
		const response = await request("not-a-media-id.jpg", storage, ctx.db);

		expect(response.status).toBe(404);
		expect(findById).not.toHaveBeenCalled();
		findById.mockRestore();
	});

	it("does not fall back after a non-not-found storage error", async () => {
		const media = await repo.create({
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			storageKey: "photo.jpg",
		});
		const download = vi.fn().mockRejectedValue(new Error("permission denied"));
		const findById = vi.spyOn(MediaRepository.prototype, "findById");

		const response = await request(media.id, { download }, ctx.db);
		expect(response.status).toBe(500);
		expect(findById).not.toHaveBeenCalled();
		findById.mockRestore();
	});
});
