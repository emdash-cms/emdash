import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaRepository, type MediaStatus } from "../../../src/database/repositories/media.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("MediaRepository numbered pages", (dialect) => {
	let ctx: DialectTestContext;
	let repo: MediaRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		repo = new MediaRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createMedia(
		filename: string,
		createdAt: string,
		mimeType = "image/jpeg",
		status: MediaStatus = "ready",
	) {
		const item = await repo.create({
			filename,
			mimeType,
			storageKey: filename,
			status,
		});
		await ctx.db
			.updateTable("media")
			.set({ created_at: createdAt })
			.where("id", "=", item.id)
			.execute();
	}

	async function seedMedia() {
		await createMedia("oldest.jpg", "2026-01-01T00:00:00.000Z");
		await createMedia("guide.pdf", "2026-01-02T00:00:00.000Z", "application/pdf");
		await createMedia("middle.jpg", "2026-01-03T00:00:00.000Z");
		await createMedia("newest.jpg", "2026-01-04T00:00:00.000Z");
		await createMedia("pending.jpg", "2026-01-05T00:00:00.000Z", "image/jpeg", "pending");
		await createMedia("failed.jpg", "2026-01-06T00:00:00.000Z", "image/jpeg", "failed");
	}

	it("returns disjoint stable pages with the exact ready-item total", async () => {
		await seedMedia();

		const first = await repo.findPage({ page: 1, limit: 2 });
		const second = await repo.findPage({ page: 2, limit: 2 });
		const beyond = await repo.findPage({ page: 3, limit: 2 });

		expect(first).toMatchObject({ totalCount: 4 });
		expect(first.items.map((item) => item.filename)).toEqual(["newest.jpg", "middle.jpg"]);
		expect(second).toMatchObject({ totalCount: 4 });
		expect(second.items.map((item) => item.filename)).toEqual(["guide.pdf", "oldest.jpg"]);
		expect(beyond).toEqual({ items: [], totalCount: 4 });
	});

	it("applies filename and MIME filters to both rows and total", async () => {
		await seedMedia();

		const result = await repo.findPage({
			page: 2,
			limit: 2,
			q: ".jpg",
			mimeType: "image/",
		});

		expect(result.totalCount).toBe(3);
		expect(typeof result.totalCount).toBe("number");
		expect(result.items.map((item) => item.filename)).toEqual(["oldest.jpg"]);
	});

	it("applies the same folder filter to cursor rows, page rows, and totals", async () => {
		await seedMedia();
		const cursorOptions = { limit: 2, folderId: "missing-folder" };
		const pageOptions = { page: 1, limit: 2, folderId: "missing-folder" };

		const cursorResult = await repo.findMany(cursorOptions);
		const pageResult = await repo.findPage(pageOptions);

		expect(cursorResult).toEqual({ items: [], nextCursor: undefined });
		expect(pageResult).toEqual({ items: [], totalCount: 0 });
	});
});
