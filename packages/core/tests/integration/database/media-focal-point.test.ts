import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaRepository } from "../../../src/database/repositories/media.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("MediaRepository focal point", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("stores and resets the focal point without changing other metadata", async () => {
		const repo = new MediaRepository(ctx.db);
		const created = await repo.create({
			filename: "portrait.jpg",
			mimeType: "image/jpeg",
			storageKey: "portrait.jpg",
			alt: "Portrait",
		});

		expect(created).toMatchObject({ focalX: null, focalY: null });

		const focused = await repo.update(created.id, { focalX: 0, focalY: 1 });
		expect(focused).toMatchObject({
			focalX: 0,
			focalY: 1,
			alt: "Portrait",
		});
		const listed = await repo.findMany();
		expect(listed.items).toMatchObject([{ id: created.id, focalX: 0, focalY: 1 }]);

		const reset = await repo.update(created.id, { focalX: null, focalY: null });
		expect(reset).toMatchObject({ focalX: null, focalY: null, alt: "Portrait" });
	});

	it("normalizes a malformed stored pair to the centered fallback", async () => {
		const repo = new MediaRepository(ctx.db);
		const created = await repo.create({
			filename: "portrait.jpg",
			mimeType: "image/jpeg",
			storageKey: "portrait.jpg",
		});
		await ctx.db
			.updateTable("media")
			.set({ focal_x: 0.4, focal_y: null })
			.where("id", "=", created.id)
			.execute();

		expect(await repo.findById(created.id)).toMatchObject({ focalX: null, focalY: null });
	});
});
