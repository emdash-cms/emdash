import { ulid } from "ulidx";
import { afterEach, beforeEach, expect } from "vitest";

import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("repeater media-field normalization", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;
	let mediaId: string;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		// A top-level image field, used as the reference for how a bare media id should normalize.
		await registry.createField("posts", { slug: "hero", label: "Hero", type: "image" });
		await registry.createField("posts", {
			slug: "gallery",
			label: "Gallery",
			type: "repeater",
			validation: { subFields: [{ slug: "image", type: "image", label: "Image" }] },
		});

		mediaId = ulid();
		await ctx.db
			.insertInto("media")
			.values({
				id: mediaId,
				filename: "hero.jpg",
				mime_type: "image/jpeg",
				size: 100,
				width: 1080,
				height: 1920,
				alt: null,
				caption: null,
				storage_key: "hero.jpg",
				content_hash: null,
				blurhash: null,
				dominant_color: null,
				status: "ready",
				author_id: null,
			})
			.execute();

		runtime = createTestRuntime(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("normalizes a bare media id inside a repeater image sub-field like a top-level field", async () => {
		const result = await runtime.handleContentCreate("posts", {
			slug: "p1",
			data: { title: "p1", hero: mediaId, gallery: [{ image: mediaId }] },
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const data = result.data.item.data as Record<string, unknown>;
		const hero = data.hero;
		const gallery = data.gallery as Array<Record<string, unknown>>;
		const subImage = gallery[0].image;

		// Before the fix the bare id string was stored verbatim inside the repeater item, so the
		// admin rendered "Image not found". It must now be normalized exactly like the top-level
		// `hero` field (a MediaValue object, not the raw id string).
		expect(typeof subImage).toBe("object");
		expect(subImage).not.toBe(mediaId);
		expect(subImage).toEqual(hero);
	});
});
