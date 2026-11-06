import { LiveEntryNotFoundError } from "astro/content/runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("astro:content", () => ({ getLiveEntry: vi.fn() }));

import { getLiveEntry } from "astro:content";

import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { emdashLoader } from "../../../src/loader.js";
import { createMediaProvider } from "../../../src/media/local-runtime.js";
import { mediaItemToValue } from "../../../src/media/types.js";
import {
	__setObjectCacheBackendForTests,
	type ObjectCacheBackend,
} from "../../../src/object-cache/index.js";
import { getEmDashEntry } from "../../../src/query.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

function memoryBackend(): ObjectCacheBackend {
	const values = new Map<string, string>();
	return {
		get: (key) => Promise.resolve(values.get(key) ?? null),
		set: (key, value) => {
			values.set(key, value);
			return Promise.resolve();
		},
		delete: (key) => {
			values.delete(key);
			return Promise.resolve();
		},
	};
}

async function flushCacheWrite(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describeEachDialect("published image captions through getEmDashEntry", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "featured_image", label: "Image", type: "image" });
		runtime = createTestRuntime(ctx.db);
		runtime.mediaProviders.set("local", createMediaProvider({ db: ctx.db }));
		__setObjectCacheBackendForTests(memoryBackend(), { revalidate: 60_000, defaultTtl: 3600 });
		vi.mocked(getLiveEntry).mockReset();
		vi.mocked(getLiveEntry).mockImplementation(async (_collection, filter) => {
			const entry = await emdashLoader().loadEntry!({ filter });
			if (!entry) {
				return { entry: undefined, error: new LiveEntryNotFoundError(filter.type, filter.id) };
			}
			return { entry, error: undefined, cacheHint: entry.cacheHint };
		});
	});

	afterEach(async () => {
		__setObjectCacheBackendForTests(null);
		await teardownForDialect(ctx);
	});

	it.each(["Test xxx", ""])(
		"returns a %j caption after media editing and republishing",
		async (caption) => {
			const provider = runtime.mediaProviders.get("local")!;
			const media = await new MediaRepository(ctx.db).create({
				filename: "photo.jpg",
				mimeType: "image/jpeg",
				storageKey: "photo.jpg",
				width: 1200,
				height: 800,
				blurhash: "LmG[{5M|s.oz.ARkWBj]4?oeNGae",
				dominantColor: "rgb(126,126,124)",
			});
			const initial = await provider.list({});
			const created = await runtime.handleContentCreate("posts", {
				slug: "captioned-post",
				data: { featured_image: mediaItemToValue("local", initial.items[0]!) },
			});
			if (!created.success) throw new Error(JSON.stringify(created.error));
			const firstPublish = await runtime.handleContentPublish("posts", created.data.item.id);
			if (!firstPublish.success) throw new Error(JSON.stringify(firstPublish.error));

			const read = () =>
				runWithContext({ editMode: false, db: ctx.db }, () =>
					getEmDashEntry("posts", "captioned-post"),
				);
			const beforeEdit = await read();
			expect(beforeEdit.entry?.data.featured_image).not.toHaveProperty("caption");
			await flushCacheWrite();
			const cachedBeforeEdit = await read();
			expect(cachedBeforeEdit.entry?.data.featured_image).not.toHaveProperty("caption");
			expect(getLiveEntry).toHaveBeenCalledTimes(1);

			const saved = await runtime.handleMediaUpdate(media.id, { caption });
			if (!saved.success) throw new Error(JSON.stringify(saved.error));
			const changed = await provider.list({});
			const updated = await runtime.handleContentUpdate("posts", created.data.item.id, {
				data: {
					featured_image: mediaItemToValue("local", {
						...changed.items[0]!,
						meta: { storageKey: media.storageKey },
					}),
				},
			});
			if (!updated.success) throw new Error(JSON.stringify(updated.error));
			const published = await runtime.handleContentPublish("posts", created.data.item.id);
			if (!published.success) throw new Error(JSON.stringify(published.error));

			const cold = await read();
			await flushCacheWrite();
			const warm = await read();

			expect(cold.entry?.data.featured_image).toHaveProperty("caption", caption);
			expect(warm.entry?.data.featured_image).toHaveProperty("caption", caption);
			expect(getLiveEntry).toHaveBeenCalledTimes(2);
		},
	);
});
