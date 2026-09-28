import { it, expect, describe, beforeEach, afterEach } from "vitest";

import { handleMediaList } from "../../../src/api/handlers/media.js";
import { mediaListQuery } from "../../../src/api/schemas/media.js";
import { MediaFolderRepository } from "../../../src/database/repositories/media-folders.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import {
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describe("handleMediaList multi-MIME", () => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect("sqlite");
		const repo = new MediaRepository(ctx.db);
		await repo.create({ filename: "a.png", mimeType: "image/png", storageKey: "a.png" });
		await repo.create({ filename: "b.pdf", mimeType: "application/pdf", storageKey: "b.pdf" });
		await repo.create({ filename: "c.zip", mimeType: "application/zip", storageKey: "c.zip" });
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("accepts an array of MIME entries", async () => {
		const result = await handleMediaList(ctx.db, {
			mimeType: ["image/", "application/pdf"],
		});
		if (!result.success) throw new Error("expected success");
		expect(result.data.items.map((i) => i.mimeType).toSorted()).toEqual([
			"application/pdf",
			"image/png",
		]);
	});

	it("returns one numbered page and its exact total", async () => {
		const result = await handleMediaList(ctx.db, { page: 2, limit: 2 });

		expect(result).toEqual(
			expect.objectContaining({
				success: true,
				data: expect.objectContaining({
					items: [expect.objectContaining({ filename: expect.stringMatching(/\.(png|pdf|zip)$/) })],
					totalCount: 3,
				}),
			}),
		);
	});

	it("forwards folder filters to cursor and numbered repository queries", async () => {
		const media = new MediaRepository(ctx.db);
		const folders = new MediaFolderRepository(ctx.db);
		const folder = await folders.create("Documents");
		const pdf = await media.findByFilename("b.pdf");
		if (!pdf) throw new Error("expected seeded PDF");
		await media.update(pdf.id, { folderId: folder.id });
		const folderParams = { folderId: folder.id };
		const mainPageParams = { page: 1, limit: 10, folderId: null };

		const folderResult = await handleMediaList(ctx.db, folderParams);
		const mainPageResult = await handleMediaList(ctx.db, mainPageParams);

		expect(folderResult).toMatchObject({
			success: true,
			data: { items: [expect.objectContaining({ id: pdf.id, folderId: folder.id })] },
		});
		expect(mainPageResult).toMatchObject({
			success: true,
			data: { totalCount: 2 },
		});
	});

	it("rejects invalid or ambiguous page requests before querying", async () => {
		await expect(handleMediaList(ctx.db, { page: 0 })).resolves.toMatchObject({
			success: false,
			error: { code: "VALIDATION_ERROR" },
		});
		await expect(handleMediaList(ctx.db, { page: 1, cursor: "cursor" })).resolves.toMatchObject({
			success: false,
			error: { code: "VALIDATION_ERROR" },
		});
		await expect(
			handleMediaList(ctx.db, { page: Number.MAX_SAFE_INTEGER, limit: 100 }),
		).resolves.toMatchObject({
			success: false,
			error: { code: "VALIDATION_ERROR" },
		});
	});

	it("accepts page mode in the REST query and rejects cursor plus page", () => {
		expect(mediaListQuery.parse({ page: "1" }).page).toBe(1);
		expect(mediaListQuery.safeParse({ page: "0" }).success).toBe(false);
		expect(mediaListQuery.safeParse({ page: "1.5" }).success).toBe(false);
		expect(mediaListQuery.safeParse({ page: "not-a-page" }).success).toBe(false);
		expect(mediaListQuery.safeParse({ page: "1", cursor: "cursor" }).success).toBe(false);
		expect(mediaListQuery.parse({ folderId: "unfiled" }).folderId).toBe("unfiled");
	});
});
