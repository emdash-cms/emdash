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
});
