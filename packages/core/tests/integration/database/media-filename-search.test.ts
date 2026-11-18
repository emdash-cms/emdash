import { it, expect, beforeEach, afterEach } from "vitest";

import { MediaRepository } from "../../../src/database/repositories/media.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

// #1221: the media library lacked filename search. The repository now accepts
// a case-insensitive `q` substring filter against the filename.
describeEachDialect("MediaRepository.findMany filename search (#1221)", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const repo = new MediaRepository(ctx.db);
		await repo.create({
			filename: "Summer-Vacation.png",
			mimeType: "image/png",
			storageKey: "1.png",
		});
		await repo.create({
			filename: "invoice-2024.pdf",
			mimeType: "application/pdf",
			storageKey: "2.pdf",
		});
		await repo.create({ filename: "logo.svg", mimeType: "image/svg+xml", storageKey: "3.svg" });
		await repo.create({
			filename: "100%_complete.png",
			mimeType: "image/png",
			storageKey: "4.png",
		});
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("matches a filename substring case-insensitively", async () => {
		const repo = new MediaRepository(ctx.db);
		const result = await repo.findMany({ q: "vacation" });
		expect(result.items.map((i) => i.filename)).toEqual(["Summer-Vacation.png"]);
	});

	it("matches by extension", async () => {
		const repo = new MediaRepository(ctx.db);
		const result = await repo.findMany({ q: ".pdf" });
		expect(result.items.map((i) => i.filename)).toEqual(["invoice-2024.pdf"]);
	});

	it("combines with the mimeType filter", async () => {
		const repo = new MediaRepository(ctx.db);
		const result = await repo.findMany({ q: "logo", mimeType: "image/" });
		expect(result.items.map((i) => i.filename)).toEqual(["logo.svg"]);
	});

	it("treats LIKE wildcards in the query literally", async () => {
		const repo = new MediaRepository(ctx.db);
		// "100%" must match only the literal "100%_complete.png", not every row.
		const result = await repo.findMany({ q: "100%" });
		expect(result.items.map((i) => i.filename)).toEqual(["100%_complete.png"]);
	});

	it("finds the next unused filename", async () => {
		const repo = new MediaRepository(ctx.db);
		await repo.create({ filename: "PHOTO.png", mimeType: "image/png", storageKey: "5.png" });
		await repo.create({ filename: "photo-2.png", mimeType: "image/png", storageKey: "6.png" });

		expect(await repo.findAvailableFilename("photo.png")).toBe("photo-3.png");
		expect(await repo.findAvailableFilename("unused.png")).toBe("unused.png");
	});

	it("searches ids, storage keys, and media URLs in both list modes", async () => {
		const repo = new MediaRepository(ctx.db);
		const storageKey = "01M66PYKARAMWV7H63E8S28HYA.01M66PYM1K0Y37FSW9F9XXMP3F.jpg";
		const item = await repo.create({
			filename: "url-search-image.jpg",
			mimeType: "image/jpeg",
			storageKey,
		});
		const findMany = (q: string) => repo.findMany({ q, limit: 20 });
		const findPage = (q: string) => repo.findPage({ q, page: 1, limit: 20 });
		const expected = expect.objectContaining({ id: item.id, storageKey });

		for (const q of [
			storageKey,
			"01m66pym1k",
			item.id,
			`/_emdash/api/media/file/${storageKey}?download=1#preview`,
			`https://example.test/_emdash/api/media/file/${storageKey}?download=1#preview`,
			`/_emdash/api/media/file/${storageKey}#preview?ignored=/another-file`,
			`/_emdash/api/media/file/${storageKey}?${"#".repeat(100)}\n/ignored`,
			`/_emdash/api/media/file/${storageKey}#${"#".repeat(100)}\n/ignored`,
		]) {
			expect((await findMany(q)).items).toContainEqual(expected);
			expect(await findPage(q)).toEqual({
				items: [expect.objectContaining({ id: item.id })],
				totalCount: 1,
			});
		}

		await repo.create({
			filename: "pending.jpg",
			mimeType: "image/jpeg",
			storageKey: `pending-${storageKey}`,
			status: "pending",
		});
		await repo.create({
			filename: "document.pdf",
			mimeType: "application/pdf",
			storageKey: `document-${storageKey}`,
		});
		const filters = { q: "01m66pym1k", mimeType: "image/", folderId: null } as const;
		expect((await repo.findMany(filters)).items).toEqual([
			expect.objectContaining({ id: item.id }),
		]);
		expect(await repo.findPage({ ...filters, page: 1 })).toEqual({
			items: [expect.objectContaining({ id: item.id })],
			totalCount: 1,
		});
	});

	it("matches long filenames without false positives and preserves literal search characters", async () => {
		const repo = new MediaRepository(ctx.db);
		const asciiPrefix = "ascii-common-prefix-".repeat(3);
		const multibytePrefix = "æøå".repeat(18);
		const ascii = await repo.create({
			filename: `${asciiPrefix}target.txt`,
			mimeType: "text/plain",
			storageKey: "long-ascii-target",
		});
		await repo.create({
			filename: `${asciiPrefix}other.txt`,
			mimeType: "text/plain",
			storageKey: "long-ascii-other",
		});
		const multibyte = await repo.create({
			filename: `${multibytePrefix}target.txt`,
			mimeType: "text/plain",
			storageKey: "long-multibyte-target",
		});
		await repo.create({
			filename: `${multibytePrefix}other.txt`,
			mimeType: "text/plain",
			storageKey: "long-multibyte-other",
		});
		const literal = await repo.create({
			filename: "literal%_\\\\name.txt",
			mimeType: "text/plain",
			storageKey: "literal-search",
		});

		for (const [q, id] of [
			[ascii.filename, ascii.id],
			[multibyte.filename, multibyte.id],
			[literal.filename, literal.id],
		] as const) {
			expect((await repo.findMany({ q })).items.map((item) => item.id)).toEqual([id]);
			expect((await repo.findPage({ q, page: 1, limit: 20 })).items.map((item) => item.id)).toEqual(
				[id],
			);
		}
	});

	it("does not filter empty or whitespace-only searches", async () => {
		const repo = new MediaRepository(ctx.db);
		const all = await repo.findMany({ limit: 20, q: "   " });
		const page = await repo.findPage({ page: 1, limit: 20, q: "\t\n" });

		expect(all.items).toHaveLength(4);
		expect(page.totalCount).toBe(4);
	});
});
