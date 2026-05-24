import { it, expect, beforeEach, afterEach } from "vitest";

import { MediaRepository } from "../../../src/database/repositories/media.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("MediaRepository.findMany mimeType filter", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function seedMedia() {
		const repo = new MediaRepository(ctx.db);
		await repo.create({ filename: "a.png", mimeType: "image/png", storageKey: "a.png" });
		await repo.create({ filename: "b.jpg", mimeType: "image/jpeg", storageKey: "b.jpg" });
		await repo.create({ filename: "c.pdf", mimeType: "application/pdf", storageKey: "c.pdf" });
		await repo.create({ filename: "d.zip", mimeType: "application/zip", storageKey: "d.zip" });
	}

	it("filters by a single MIME prefix (existing behavior)", async () => {
		await seedMedia();
		const repo = new MediaRepository(ctx.db);
		const result = await repo.findMany({ mimeType: "image/" });
		expect(result.items.map((i) => i.mimeType).toSorted()).toEqual(["image/jpeg", "image/png"]);
	});

	it("filters by an array of MIME entries (prefix + exact)", async () => {
		await seedMedia();
		const repo = new MediaRepository(ctx.db);
		const result = await repo.findMany({
			mimeType: ["image/", "application/pdf"],
		});
		expect(result.items.map((i) => i.mimeType).toSorted()).toEqual([
			"application/pdf",
			"image/jpeg",
			"image/png",
		]);
	});

	it("returns an empty list when none match", async () => {
		await seedMedia();
		const repo = new MediaRepository(ctx.db);
		const result = await repo.findMany({ mimeType: ["video/"] });
		expect(result.items).toEqual([]);
	});
});
