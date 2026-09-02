import { afterEach, beforeEach, expect, it } from "vitest";

import {
	handleMediaFolderCreate,
	handleMediaFolderDelete,
	handleMediaFolderGet,
	handleMediaFolderList,
	handleMediaFolderUpdate,
} from "../../../src/api/handlers/media-folders.js";
import { handleMediaUpdate } from "../../../src/api/handlers/media.js";
import { MediaFolderRepository } from "../../../src/database/repositories/media-folders.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media folder handlers", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("lists folders with bounded cursors and rejects malformed cursors", async () => {
		await handleMediaFolderCreate(ctx.db, { name: "Beta" });
		await handleMediaFolderCreate(ctx.db, { name: "Alpha" });

		const first = await handleMediaFolderList(ctx.db, { limit: 1 });
		expect(first).toMatchObject({
			success: true,
			data: { items: [{ name: "Alpha" }], nextCursor: expect.any(String) },
		});
		if (!first.success) throw new Error("expected folder list success");
		const second = await handleMediaFolderList(ctx.db, {
			limit: 1,
			cursor: first.data.nextCursor,
		});
		expect(second).toMatchObject({ success: true, data: { items: [{ name: "Beta" }] } });
		expect(await handleMediaFolderList(ctx.db, { cursor: "not-a-cursor" })).toMatchObject({
			success: false,
			error: { code: "INVALID_CURSOR" },
		});
	});

	it("normalizes and applies folder-name search before pagination", async () => {
		await handleMediaFolderCreate(ctx.db, { name: "Archive" });
		await handleMediaFolderCreate(ctx.db, { name: "Résumé" });
		const options = { q: " re\u0301su " };

		const result = await handleMediaFolderList(ctx.db, options);

		expect(result).toMatchObject({
			success: true,
			data: { items: [{ name: "Résumé" }] },
		});
	});

	it("treats folder-search wildcards literally", async () => {
		await handleMediaFolderCreate(ctx.db, { name: "100% Real" });
		await handleMediaFolderCreate(ctx.db, { name: "100 Percent" });

		const result = await handleMediaFolderList(ctx.db, { q: "%" });

		expect(result).toMatchObject({
			success: true,
			data: { items: [{ name: "100% Real" }] },
		});
	});

	it("gets one folder and returns not found for an unknown ID", async () => {
		const created = await handleMediaFolderCreate(ctx.db, { name: "Current" });
		if (!created.success) throw new Error("expected folder create success");

		expect(await handleMediaFolderGet(ctx.db, created.data.item.id)).toEqual(created);
		expect(await handleMediaFolderGet(ctx.db, "missing-folder")).toMatchObject({
			success: false,
			error: { code: "NOT_FOUND" },
		});
	});

	it("normalizes names and maps create or rename collisions to conflicts", async () => {
		const created = await handleMediaFolderCreate(ctx.db, { name: "  Photos  " });
		expect(created).toMatchObject({ success: true, data: { item: { name: "Photos" } } });
		expect(await handleMediaFolderCreate(ctx.db, { name: "ＰＨＯＴＯＳ" })).toMatchObject({
			success: false,
			error: { code: "CONFLICT" },
		});
		expect(await handleMediaFolderCreate(ctx.db, { name: "   " })).toMatchObject({
			success: false,
			error: { code: "VALIDATION_ERROR" },
		});

		const other = await handleMediaFolderCreate(ctx.db, { name: "Other" });
		if (!other.success) throw new Error("expected folder create success");
		expect(
			await handleMediaFolderUpdate(ctx.db, other.data.item.id, { name: "photos" }),
		).toMatchObject({ success: false, error: { code: "CONFLICT" } });
	});

	it("returns not found for missing updates and deletes", async () => {
		expect(await handleMediaFolderUpdate(ctx.db, "missing", { name: "Missing" })).toMatchObject({
			success: false,
			error: { code: "NOT_FOUND" },
		});
		expect(await handleMediaFolderDelete(ctx.db, "missing")).toMatchObject({
			success: false,
			error: { code: "NOT_FOUND" },
		});

		const created = await handleMediaFolderCreate(ctx.db, { name: "Temporary" });
		if (!created.success) throw new Error("expected folder create success");
		expect(await handleMediaFolderDelete(ctx.db, created.data.item.id)).toEqual({
			success: true,
			data: { deleted: true },
		});
	});

	it("maps missing assignment targets to not found without partial metadata writes", async () => {
		const folders = new MediaFolderRepository(ctx.db);
		const media = new MediaRepository(ctx.db);
		const folder = await folders.create("Working");
		const item = await media.create({
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			storageKey: "photo.jpg",
			alt: "Original",
		});

		expect(await handleMediaUpdate(ctx.db, item.id, { folderId: folder.id })).toMatchObject({
			success: true,
			data: { item: { folderId: folder.id } },
		});
		expect(
			await handleMediaUpdate(ctx.db, item.id, {
				folderId: "missing-folder",
				alt: "Must not persist",
			}),
		).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
		expect(await media.findById(item.id)).toEqual(
			expect.objectContaining({ folderId: folder.id, alt: "Original" }),
		);
	});
});
