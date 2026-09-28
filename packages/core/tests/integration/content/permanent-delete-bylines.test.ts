/** Credits belong to one entry row, so permanent delete removes only the purged row's credits. */

import { afterEach, beforeEach, expect, it } from "vitest";

import { handleContentPermanentDelete } from "../../../src/api/handlers/content.js";
import { BylineRepository } from "../../../src/database/repositories/byline.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { applySeed } from "../../../src/seed/apply.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("handleContentPermanentDelete: byline credits", (dialect) => {
	let ctx: DialectTestContext;
	let content: ContentRepository;
	let bylines: BylineRepository;
	let bylineId: string;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		content = new ContentRepository(ctx.db);
		bylines = new BylineRepository(ctx.db);
		const byline = await bylines.create({ slug: "jane", displayName: "Jane" });
		bylineId = byline.id;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function creditsFor(contentId: string, collection = "post") {
		return ctx.db
			.selectFrom("_emdash_content_bylines")
			.select("byline_id")
			.where("collection_slug", "=", collection)
			.where("content_id", "=", contentId)
			.execute();
	}

	async function trashAndPurge(id: string, collection = "post") {
		expect(await content.delete(collection, id)).toBe(true);
		const result = await handleContentPermanentDelete(ctx.db, collection, id);
		expect(result.success).toBe(true);
	}

	it("removes the credits of the purged entry", async () => {
		const post = await content.create({ type: "post", data: { title: "Credited" } });
		await bylines.setContentBylines("post", post.id, [{ bylineId }]);
		expect(await creditsFor(post.id)).toHaveLength(1);

		await trashAndPurge(post.id);

		expect(await creditsFor(post.id)).toEqual([]);
	});

	it("keeps the credits of another translation", async () => {
		const en = await content.create({ type: "post", locale: "en", data: { title: "Hello" } });
		const de = await content.create({
			type: "post",
			locale: "de",
			translationOf: en.id,
			data: { title: "Hallo" },
		});
		await bylines.setContentBylines("post", en.id, [{ bylineId }]);
		await bylines.setContentBylines("post", de.id, [{ bylineId }]);

		await trashAndPurge(en.id);

		expect(await creditsFor(en.id)).toEqual([]);
		expect(await creditsFor(de.id)).toHaveLength(1);
	});

	it("keeps the credits of an entry with the same id in another collection", async () => {
		await content.create({ type: "post", id: "hero", data: { title: "Post" } });
		await content.create({ type: "page", id: "hero", data: { title: "Page" } });
		await bylines.setContentBylines("post", "hero", [{ bylineId }]);
		await bylines.setContentBylines("page", "hero", [{ bylineId }]);

		await trashAndPurge("hero");

		expect(await creditsFor("hero")).toEqual([]);
		expect(await creditsFor("hero", "page")).toHaveLength(1);
	});

	it("does not credit a seed entry re-created under the purged entry's id", async () => {
		const blocks = {
			slug: "block",
			label: "Blocks",
			routable: false,
			fields: [{ slug: "title", label: "Title", type: "string" as const }],
		};
		await applySeed(
			ctx.db,
			{
				version: "1",
				collections: [blocks],
				bylines: [{ id: "editorial", slug: "editorial", displayName: "Editorial" }],
				content: {
					block: [{ id: "hero", data: { title: "Hero" }, bylines: [{ byline: "editorial" }] }],
				},
			},
			{ includeContent: true },
		);
		expect(await bylines.getContentBylines("block", "hero")).toHaveLength(1);

		await trashAndPurge("hero", "block");
		const reseeded = await applySeed(
			ctx.db,
			{
				version: "1",
				collections: [blocks],
				content: { block: [{ id: "hero", data: { title: "Hero" } }] },
			},
			{ includeContent: true },
		);

		expect(reseeded.content.created).toBe(1);
		expect(await bylines.getContentBylines("block", "hero")).toEqual([]);
	});
});
