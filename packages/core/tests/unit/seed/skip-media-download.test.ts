import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import type { MediaValue } from "../../../src/media/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { applySeed } from "../../../src/seed/apply.js";
import type { SeedFile } from "../../../src/seed/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

// Mock fetch globally -- should NOT be called when skipMediaDownload is true
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("applySeed with skipMediaDownload", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		mockFetch.mockReset();

		// Set up a collection with an image field
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", {
			slug: "title",
			label: "Title",
			type: "string",
		});
		await registry.createField("posts", {
			slug: "featured_image",
			label: "Featured Image",
			type: "image",
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		vi.restoreAllMocks();
	});

	it("should resolve $media to external URL without downloading", async () => {
		const seed: SeedFile = {
			version: "1",
			content: {
				posts: [
					{
						id: "post-1",
						slug: "hello",
						data: {
							title: "Hello World",
							featured_image: {
								$media: {
									url: "https://images.unsplash.com/photo-abc123",
									alt: "A test image",
									filename: "test-image.jpg",
								},
							},
						},
					},
				],
			},
		};

		const result = await applySeed(db, seed, {
			includeContent: true,
			skipMediaDownload: true,
		});

		// Media should be skipped (resolved to an external reference) and not downloaded
		expect(result.media.created).toBe(0);
		expect(result.media.skipped).toBe(1);
		expect(result.content.created).toBe(1);

		// fetch should NOT have been called
		expect(mockFetch).not.toHaveBeenCalled();

		// Check the content has an external MediaValue
		const contentRepo = new ContentRepository(db);
		const entry = await contentRepo.findBySlug("posts", "hello");
		expect(entry).toBeDefined();

		const image = entry!.data.featured_image as MediaValue;
		expect(image).toBeDefined();
		expect(image.provider).toBe("external");
		expect(image.src).toBe("https://images.unsplash.com/photo-abc123");
		expect(image.alt).toBe("A test image");
		expect(image.filename).toBe("test-image.jpg");
		expect(image.id).toBeDefined(); // synthetic ULID
	});

	it("should not require a storage adapter", async () => {
		const seed: SeedFile = {
			version: "1",
			content: {
				posts: [
					{
						id: "post-1",
						slug: "no-storage",
						data: {
							title: "No Storage",
							featured_image: {
								$media: {
									url: "https://example.com/image.jpg",
									alt: "Test",
								},
							},
						},
					},
				],
			},
		};

		// No storage adapter provided -- should work fine with skipMediaDownload
		const result = await applySeed(db, seed, {
			includeContent: true,
			skipMediaDownload: true,
			// Intentionally no storage
		});

		expect(result.media.created).toBe(0);
		expect(result.media.skipped).toBe(1);
		expect(result.content.created).toBe(1);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("should cache external media references by URL", async () => {
		const seed: SeedFile = {
			version: "1",
			content: {
				posts: [
					{
						id: "post-1",
						slug: "first",
						data: {
							title: "First Post",
							featured_image: {
								$media: {
									url: "https://example.com/shared-image.jpg",
									alt: "First alt",
								},
							},
						},
					},
					{
						id: "post-2",
						slug: "second",
						data: {
							title: "Second Post",
							featured_image: {
								$media: {
									url: "https://example.com/shared-image.jpg",
									alt: "Second alt",
								},
							},
						},
					},
				],
			},
		};

		const result = await applySeed(db, seed, {
			includeContent: true,
			skipMediaDownload: true,
		});

		// Both references are resolved to external references; the second is served from cache
		expect(result.media.created).toBe(0);
		expect(result.media.skipped).toBe(2);
		expect(result.content.created).toBe(2);

		// Second entry should use the cached alt override
		const contentRepo = new ContentRepository(db);
		const second = await contentRepo.findBySlug("posts", "second");
		const image = second!.data.featured_image as MediaValue;
		expect(image.alt).toBe("Second alt");
		expect(image.src).toBe("https://example.com/shared-image.jpg");
	});

	it("should handle content with no $media refs when skipMediaDownload is set", async () => {
		const seed: SeedFile = {
			version: "1",
			content: {
				posts: [
					{
						id: "post-1",
						slug: "no-media",
						data: {
							title: "No Media",
						},
					},
				],
			},
		};

		const result = await applySeed(db, seed, {
			includeContent: true,
			skipMediaDownload: true,
		});

		expect(result.content.created).toBe(1);
		expect(result.media.created).toBe(0);
		expect(mockFetch).not.toHaveBeenCalled();
	});
});
