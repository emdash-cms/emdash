import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { createMediaProvider, repoItemToProviderItem } from "../../../src/media/local-runtime.js";
import { mediaItemToValue } from "../../../src/media/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("image captions in content responses", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;
	let mediaId: string;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "hero", label: "Hero", type: "image" });
		runtime = createTestRuntime(ctx.db);
		runtime.mediaProviders.set("local", createMediaProvider({ db: ctx.db }));
		const item = await new MediaRepository(ctx.db).create({
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			storageKey: "photo.jpg",
			width: 1200,
			height: 800,
		});
		mediaId = item.id;
		const saved = await runtime.handleMediaUpdate(mediaId, {
			alt: "Alt text xxxx",
			caption: "Test xxx",
		});
		if (!saved.success) throw new Error(JSON.stringify(saved.error));
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("includes the saved caption when selecting and resolving a local image", async () => {
		const provider = runtime.mediaProviders.get("local")!;
		const listed = await provider.list({});
		expect(listed.items[0]).toHaveProperty("caption", "Test xxx");
		const item = await new MediaRepository(ctx.db).findById(mediaId);
		expect(repoItemToProviderItem(item!)).toHaveProperty("caption", "Test xxx");

		const created = await runtime.handleContentCreate("posts", {
			slug: "image-caption",
			data: { hero: mediaItemToValue("local", listed.items[0]!) },
		});
		if (!created.success) throw new Error(JSON.stringify(created.error));
		expect(created.data.item.data.hero).toMatchObject({
			id: mediaId,
			alt: "Alt text xxxx",
			caption: "Test xxx",
		});

		const updated = await runtime.handleContentUpdate("posts", created.data.item.id, {
			data: { hero: mediaId },
		});
		if (!updated.success) throw new Error(JSON.stringify(updated.error));
		expect(updated.data.item.data.hero).toHaveProperty("caption", "Test xxx");

		const fetched = await runtime.handleContentGet("posts", created.data.item.id);
		if (!fetched.success) throw new Error(JSON.stringify(fetched.error));
		expect(fetched.data.item.data.hero).toHaveProperty("caption", "Test xxx");
	});

	it.each(["Per-use credit", ""])(
		"persists a per-use caption %j instead of the library default",
		async (caption) => {
			const created = await runtime.handleContentCreate("posts", {
				slug: "per-use-caption",
				data: { hero: { id: mediaId, provider: "local", caption } },
			});
			if (!created.success) throw new Error(JSON.stringify(created.error));
			expect(created.data.item.data.hero).toMatchObject({ caption, meta: { caption } });
			const fetched = await runtime.handleContentGet("posts", created.data.item.id);
			if (!fetched.success) throw new Error(JSON.stringify(fetched.error));
			expect(fetched.data.item.data.hero).toMatchObject({ caption, meta: { caption } });
		},
	);
});
