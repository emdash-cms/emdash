/**
 * Regression for #3919: seed $media references must be idempotent and
 * skip-media mode must not create local rows.
 */

import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import { setDefaultDnsResolver } from "../../../src/import/ssrf.js";
import { applySeed } from "../../../src/seed/apply.js";
import type { SeedFile } from "../../../src/seed/types.js";
import type { Storage } from "../../../src/storage/types.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const mediaUrl = "https://example.com/seed-media.png";

// Minimal 1x1 transparent PNG
const tinyPng = new Uint8Array(
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"base64",
	),
);

function makeTestStorage(): Storage & { uploads: Map<string, Uint8Array> } {
	const uploads = new Map<string, Uint8Array>();
	return {
		uploads,
		async upload({ key, body }) {
			let buffer: Uint8Array;
			if (body instanceof Uint8Array) {
				buffer = body;
			} else if (body instanceof ReadableStream) {
				const reader = body.getReader();
				const chunks: Uint8Array[] = [];
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					chunks.push(value);
				}
				buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
			} else {
				buffer = new Uint8Array(body);
			}
			uploads.set(key, buffer);
			return { key, url: `https://cdn.example/${key}`, size: buffer.byteLength };
		},
		async download(key) {
			const buffer = uploads.get(key);
			if (!buffer) throw new Error("Not found");
			return {
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(buffer);
						controller.close();
					},
				}),
				contentType: "image/png",
				size: buffer.byteLength,
			};
		},
		async delete(key) {
			uploads.delete(key);
		},
		async exists(key) {
			return uploads.has(key);
		},
		async list() {
			return {
				files: Array.from(uploads.keys(), (key) => ({
					key,
					size: uploads.get(key)!.byteLength,
					lastModified: new Date(),
				})),
			};
		},
		async getSignedUploadUrl() {
			throw new Error("Not supported");
		},
		getPublicUrl(key) {
			return `https://cdn.example/${key}`;
		},
	};
}

function makeSeed(): SeedFile {
	return {
		version: "1",
		collections: [
			{
				slug: "mediapost",
				label: "Media posts",
				labelSingular: "Media post",
				fields: [
					{ slug: "title", label: "Title", type: "string" },
					{ slug: "hero", label: "Hero", type: "image" },
				],
			},
		],
		content: {
			mediapost: [
				{
					id: "seed-post",
					slug: "seed-post",
					data: {
						title: "Seeded post",
						hero: { $media: { url: mediaUrl, alt: "Hero image", filename: "hero.png" } },
					},
				},
			],
		},
	};
}

describeEachDialect("seed $media idempotency (#3919)", (dialect) => {
	let ctx: DialectTestContext;
	let storage: ReturnType<typeof makeTestStorage>;
	let previousResolver: ReturnType<typeof setDefaultDnsResolver>;
	let fetchSpy: MockInstance<typeof globalThis.fetch> | undefined;

	beforeEach(async () => {
		storage = makeTestStorage();
		previousResolver = setDefaultDnsResolver(async () => ["8.8.8.8"]);
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : "";
			if (requestUrl === mediaUrl) {
				return new Response(tinyPng, {
					status: 200,
					headers: { "content-type": "image/png" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		ctx = await setupForDialectWithCollections(dialect);
	});

	afterEach(async () => {
		fetchSpy?.mockRestore();
		setDefaultDnsResolver(previousResolver);
		await teardownForDialect(ctx);
	});

	it("reuses existing media rows when re-applying a seed with update", async () => {
		const seed = makeSeed();
		const first = await applySeed(ctx.db, seed, { includeContent: true, storage });
		expect(first.content.created).toBe(1);
		expect(first.media.created).toBe(1);

		const mediaRepo = new MediaRepository(ctx.db);
		const contentRepo = new ContentRepository(ctx.db);
		const rowsAfterFirst = await mediaRepo.findMany({ limit: 100 });
		expect(rowsAfterFirst.items).toHaveLength(1);
		const firstMediaId = rowsAfterFirst.items[0]!.id;

		const firstPost = await contentRepo.findBySlug("mediapost", "seed-post", "en");
		expect(firstPost?.data.hero).toMatchObject({ id: firstMediaId, provider: "local" });

		const second = await applySeed(ctx.db, seed, {
			includeContent: true,
			onConflict: "update",
			storage,
		});
		expect(second.content.updated).toBe(1);
		expect(second.media.created).toBe(0);
		expect(second.media.skipped).toBe(1);

		const rowsAfterSecond = await mediaRepo.findMany({ limit: 100 });
		expect(rowsAfterSecond.items).toHaveLength(1);
		expect(rowsAfterSecond.items[0]!.id).toBe(firstMediaId);

		const secondPost = await contentRepo.findBySlug("mediapost", "seed-post", "en");
		expect(secondPost?.data.hero).toMatchObject({ id: firstMediaId });
	});

	it("does not create media rows or storage objects in skip-media mode", async () => {
		const seed = makeSeed();
		const result = await applySeed(ctx.db, seed, { includeContent: true, skipMediaDownload: true });
		expect(result.content.created).toBe(1);
		expect(result.media.created).toBe(0);
		expect(result.media.skipped).toBe(1);

		expect(fetchSpy).not.toHaveBeenCalledWith(expect.stringContaining(mediaUrl), expect.anything());

		const mediaRepo = new MediaRepository(ctx.db);
		const rows = await mediaRepo.findMany({ limit: 100 });
		expect(rows.items).toHaveLength(0);
		expect(storage.uploads.size).toBe(0);

		const contentRepo = new ContentRepository(ctx.db);
		const post = await contentRepo.findBySlug("mediapost", "seed-post", "en");
		expect(post?.data.hero).toMatchObject({
			provider: "external",
			src: mediaUrl,
		});
	});
});
