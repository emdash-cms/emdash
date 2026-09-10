import { afterEach, beforeEach, expect, it } from "vitest";

import { columnExists, indexExists, tableExists } from "../../../src/database/dialect-helpers.js";
import * as migration072 from "../../../src/database/migrations/072_media_folders.js";
import { MediaFolderRepository } from "../../../src/database/repositories/media-folders.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import { EmDashValidationError } from "../../../src/database/repositories/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media folder storage and repositories", (dialect) => {
	let ctx: DialectTestContext;
	let folders: MediaFolderRepository;
	let media: MediaRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		folders = new MediaFolderRepository(ctx.db);
		media = new MediaRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("upgrades existing media into the Main library and supports rollback", async () => {
		await migration072.down(ctx.db);
		await ctx.db
			.insertInto("media")
			.values({
				id: "existing-media",
				filename: "existing.jpg",
				mime_type: "image/jpeg",
				size: 123,
				width: 640,
				height: 480,
				alt: "Existing alt",
				caption: "Existing caption",
				storage_key: "uploads/existing.jpg",
				status: "ready",
				content_hash: "existing-hash",
				blurhash: "existing-blurhash",
				dominant_color: "#112233",
				author_id: "author-1",
			})
			.execute();

		await migration072.up(ctx.db);

		expect(await tableExists(ctx.db, "media_folders")).toBe(true);
		expect(await columnExists(ctx.db, "media", "folder_id")).toBe(true);
		expect(await indexExists(ctx.db, "idx_media_folder_id")).toBe(true);
		const upgraded = await ctx.db
			.selectFrom("media")
			.select(["id", "storage_key", "alt", "caption", "content_hash", "folder_id"])
			.where("id", "=", "existing-media")
			.executeTakeFirstOrThrow();
		expect(upgraded).toEqual({
			id: "existing-media",
			storage_key: "uploads/existing.jpg",
			alt: "Existing alt",
			caption: "Existing caption",
			content_hash: "existing-hash",
			folder_id: null,
		});

		await migration072.down(ctx.db);

		expect(await tableExists(ctx.db, "media_folders")).toBe(false);
		expect(await columnExists(ctx.db, "media", "folder_id")).toBe(false);
		expect(await indexExists(ctx.db, "idx_media_folder_id")).toBe(false);
		expect(
			await ctx.db
				.selectFrom("media")
				.select(["id", "storage_key", "alt", "caption", "content_hash"])
				.where("id", "=", "existing-media")
				.executeTakeFirst(),
		).toEqual({
			id: "existing-media",
			storage_key: "uploads/existing.jpg",
			alt: "Existing alt",
			caption: "Existing caption",
			content_hash: "existing-hash",
		});
	});

	it("normalizes names and traverses folders with a stable cursor", async () => {
		const resume = await folders.create("  Résumé  ");
		const archive = await folders.create("Archive");
		const drafts = await folders.create("Drafts");

		expect(resume.name).toBe("Résumé");
		expect(await folders.findById(archive.id)).toEqual(archive);
		await expect(folders.create(" re\u0301sume\u0301 ")).rejects.toThrow();
		await expect(folders.update(drafts.id, "ＡＲＣＨＩＶＥ")).rejects.toThrow();
		expect(await folders.findById(drafts.id)).toEqual(drafts);

		const first = await folders.findMany({ limit: 2 });
		expect(first.items.map((folder) => folder.name)).toEqual(["Archive", "Drafts"]);
		expect(first.nextCursor).toBeDefined();
		const second = await folders.findMany({ limit: 2, cursor: first.nextCursor });
		expect(second).toEqual({ items: [resume], nextCursor: undefined });

		const renamed = await folders.update(drafts.id, "  Published  ");
		expect(renamed).toEqual({ id: drafts.id, name: "Published" });
		expect(await folders.update("missing-folder", "Missing")).toBeNull();
		expect(await folders.delete(archive.id)).toBe(true);
		expect(await folders.delete(archive.id)).toBe(false);
		expect(await folders.findById(archive.id)).toBeNull();
	});

	it("rejects empty and overlong names before writing", async () => {
		await expect(folders.create(" \t\n ")).rejects.toBeInstanceOf(EmDashValidationError);
		await expect(folders.create("a".repeat(201))).rejects.toBeInstanceOf(EmDashValidationError);
		expect(await folders.findMany()).toEqual({ items: [], nextCursor: undefined });
	});

	it("composes folder, readiness, filename, and MIME filters in both list modes", async () => {
		const photos = await folders.create("Photos");
		const archive = await folders.create("Archive");
		const rootCat = await media.create({
			filename: "root-cat.jpg",
			mimeType: "image/jpeg",
			storageKey: "root-cat.jpg",
		});
		await media.create({
			filename: "root-guide.pdf",
			mimeType: "application/pdf",
			storageKey: "root-guide.pdf",
		});
		const photoCat = await media.create({
			filename: "photo-cat.jpg",
			mimeType: "image/jpeg",
			storageKey: "photo-cat.jpg",
		});
		const photoGuide = await media.create({
			filename: "photo-guide.pdf",
			mimeType: "application/pdf",
			storageKey: "photo-guide.pdf",
		});
		const pendingCat = await media.create({
			filename: "pending-cat.jpg",
			mimeType: "image/jpeg",
			storageKey: "pending-cat.jpg",
			status: "pending",
		});
		const archivedCat = await media.create({
			filename: "archived-cat.jpg",
			mimeType: "image/jpeg",
			storageKey: "archived-cat.jpg",
		});
		await media.update(photoCat.id, { folderId: photos.id });
		await media.update(photoGuide.id, { folderId: photos.id });
		await media.update(pendingCat.id, { folderId: photos.id });
		await media.update(archivedCat.id, { folderId: archive.id });

		const allCats = await media.findMany({ limit: 20, q: "cat", mimeType: "image/" });
		expect(allCats.items.map((item) => item.filename).toSorted()).toEqual([
			"archived-cat.jpg",
			"photo-cat.jpg",
			"root-cat.jpg",
		]);
		const mainCats = await media.findMany({
			limit: 20,
			folderId: null,
			q: "cat",
			mimeType: "image/",
		});
		expect(mainCats.items).toEqual([expect.objectContaining({ id: rootCat.id, folderId: null })]);

		const cursorResult = await media.findMany({
			limit: 20,
			folderId: photos.id,
			q: ".jpg",
			mimeType: "image/",
		});
		const pageResult = await media.findPage({
			page: 1,
			limit: 20,
			folderId: photos.id,
			q: ".jpg",
			mimeType: "image/",
		});
		expect(cursorResult.items).toEqual([
			expect.objectContaining({ id: photoCat.id, folderId: photos.id }),
		]);
		expect(pageResult).toEqual({ items: cursorResult.items, totalCount: 1 });
	});

	it("updates assignments atomically and returns deleted-folder media to the Main library", async () => {
		const folder = await folders.create("Working");
		const item = await media.create({
			filename: "source.jpg",
			mimeType: "image/jpeg",
			storageKey: "stable/source.jpg",
			alt: "Original alt",
			caption: "Original caption",
			width: 1280,
			height: 720,
		});

		const assigned = await media.update(item.id, {
			folderId: folder.id,
			alt: "Updated alt",
		});
		expect(assigned).toEqual(
			expect.objectContaining({
				id: item.id,
				storageKey: "stable/source.jpg",
				folderId: folder.id,
				alt: "Updated alt",
				caption: "Original caption",
			}),
		);
		expect(await media.update(item.id, { folderId: null })).toEqual({
			...assigned,
			folderId: null,
		});
		expect(await media.update(item.id, { folderId: folder.id })).toEqual(assigned);

		await expect(
			media.update(item.id, { folderId: "missing-folder", alt: "Must not persist" }),
		).rejects.toThrow();
		expect(await media.findById(item.id)).toEqual(assigned);

		expect(await folders.delete(folder.id)).toBe(true);
		const afterDelete = await media.findById(item.id);
		expect(afterDelete).toEqual({ ...assigned, folderId: null });
		expect(afterDelete).toEqual(
			expect.objectContaining({
				id: item.id,
				storageKey: "stable/source.jpg",
				alt: "Updated alt",
				caption: "Original caption",
				width: 1280,
				height: 720,
			}),
		);
		expect((await media.findMany({ folderId: null })).items).toEqual([afterDelete]);
	});
});
