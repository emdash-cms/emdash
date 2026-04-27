import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { setDefaultDnsResolver } from "../../../src/import/ssrf.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { applySeed } from "../../../src/seed/apply.js";
import type { SeedFile } from "../../../src/seed/types.js";
import type { Storage, UploadOptions } from "../../../src/storage/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

// Regex patterns for file validation
const PNG_EXTENSION_REGEX = /\.png$/;

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Bypass DoH so the fetch mock only sees the calls these tests model.
let previousResolver: ReturnType<typeof setDefaultDnsResolver> | undefined;
beforeAll(() => {
	previousResolver = setDefaultDnsResolver(async () => ["93.184.216.34"]);
});
afterAll(() => {
	setDefaultDnsResolver(previousResolver ?? null);
});

// Create a mock storage that tracks uploads
function createMockStorage(): Storage & { uploads: UploadOptions[] } {
	const uploads: UploadOptions[] = [];

	return {
		uploads,
		async upload(options: UploadOptions): Promise<void> {
			uploads.push(options);
		},
		async download(key: string): Promise<{ body: Uint8Array; contentType: string }> {
			const upload = uploads.find((u) => u.key === key);
			if (!upload) throw new Error(`Not found: ${key}`);
			return { body: upload.body, contentType: upload.contentType };
		},
		async delete(key: string): Promise<void> {
			const index = uploads.findIndex((u) => u.key === key);
			if (index >= 0) uploads.splice(index, 1);
		},
		async exists(key: string): Promise<boolean> {
			return uploads.some((u) => u.key === key);
		},
		getPublicUrl(key: string): string {
			return `https://storage.example.com/${key}`;
		},
	};
}

// Create a mock response for fetch
function createMockResponse(
	body: Uint8Array,
	contentType: string,
	ok = true,
	status = 200,
): Response {
	return {
		ok,
		status,
		headers: new Headers({ "content-type": contentType }),
		arrayBuffer: async () => body.buffer,
	} as Response;
}

// Simple 1x1 PNG for testing
const MOCK_PNG = new Uint8Array([
	0x89,
	0x50,
	0x4e,
	0x47,
	0x0d,
	0x0a,
	0x1a,
	0x0a, // PNG signature
	0x00,
	0x00,
	0x00,
	0x0d, // IHDR length
	0x49,
	0x48,
	0x44,
	0x52, // IHDR chunk type
	0x00,
	0x00,
	0x00,
	0x01, // width: 1
	0x00,
	0x00,
	0x00,
	0x01, // height: 1
	0x08,
	0x02,
	0x00,
	0x00,
	0x00, // bit depth, color type, etc.
	0x90,
	0x77,
	0x53,
	0xde, // CRC
]);

// Simple 1x1 JPEG for testing
const MOCK_JPEG = new Uint8Array([
	0xff,
	0xd8,
	0xff,
	0xe0, // SOI + APP0
	0x00,
	0x10, // APP0 length
	0x4a,
	0x46,
	0x49,
	0x46,
	0x00, // JFIF identifier
	0x01,
	0x01, // version
	0x00, // aspect ratio units
	0x00,
	0x01, // X density (1)
	0x00,
	0x01, // Y density (1)
	0x00,
	0x00, // thumbnail dimensions
	0xff,
	0xd9, // EOI
]);

describe("$media seed resolution", () => {
	let db: Kysely<Database>;
	let storage: Storage & { uploads: UploadOptions[] };

	beforeEach(async () => {
		db = await setupTestDatabase();
		storage = createMockStorage();
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

	it("should resolve $media references by downloading and uploading", async () => {
		mockFetch.mockResolvedValueOnce(createMockResponse(MOCK_PNG, "image/png"));

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
									url: "https://example.com/image.png",
									alt: "Test image",
									filename: "my-image.png",
								},
							},
						},
					},
				],
			},
		};

		const result = await applySeed(db, seed, {
			includeContent: true,
			storage,
			baseUrl: "https://mysite.com",
		});

		expect(result.media.created).toBe(1);
		expect(result.content.created).toBe(1);
		expect(storage.uploads).toHaveLength(1);

		// Check the upload
		expect(storage.uploads[0].contentType).toBe("image/png");
		expect(storage.uploads[0].key).toMatch(PNG_EXTENSION_REGEX);

		// Check the content has resolved ImageValue
		const contentRepo = new ContentRepository(db);
		const entry = await contentRepo.findBySlug("posts", "hello");

		// ImageValue stores id (URL is built at runtime by EmDashImage)
		expect(entry?.data.featured_image).toMatchObject({
			id: expect.any(String),
			alt: "Test image",
		});
	});

	it("should cache repeated $media URLs", async () => {
		mockFetch.mockResolvedValueOnce(createMockResponse(MOCK_JPEG, "image/jpeg"));

		const seed: SeedFile = {
			version: "1",
			content: {
				posts: [
					{
						id: "post-1",
						slug: "first",
						data: {
							title: "First",
							featured_image: {
								$media: {
									url: "https://example.com/shared.jpg",
									alt: "Shared image",
								},
							},
						},
					},
					{
						id: "post-2",
						slug: "second",
						data: {
							title: "Second",
							featured_image: {
								$media: {
									url: "https://example.com/shared.jpg",
									alt: "Different alt text",
								},
							},
						},
					},
				],
			},
		};

		const result = await applySeed(db, seed, {
			includeContent: true,
			storage,
			baseUrl: "",
		});

		// Only downloaded/uploaded once
		expect(result.media.created).toBe(1);
		expect(result.media.skipped).toBe(1);
		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(storage.uploads).toHaveLength(1);

		// Both entries should have the same src but different alt
		const contentRepo = new ContentRepository(db);
		const first = await contentRepo.findBySlug("posts", "first");
		const second = await contentRepo.findBySlug("posts", "second");

		expect(first?.data.featured_image.src).toBe(second?.data.featured_image.src);
		expect(first?.data.featured_image.alt).toBe("Shared image");
		expect(second?.data.featured_image.alt).toBe("Different alt text");
	});

	it("should skip $media when storage is not configured", async () => {
		const seed: SeedFile = {
			version: "1",
			content: {
				posts: [
					{
						id: "post-1",
						slug: "hello",
						data: {
							title: "Hello",
							featured_image: {
								$media: {
									url: "https://example.com/image.png",
									alt: "Test",
								},
							},
						},
					},
				],
			},
		};

		// No storage provided
		const result = await applySeed(db, seed, { includeContent: true });

		expect(result.media.skipped).toBe(1);
		expect(result.media.created).toBe(0);
		expect(mockFetch).not.toHaveBeenCalled();

		// Image field should be null/undefined (not resolved)
		const contentRepo = new ContentRepository(db);
		const entry = await contentRepo.findBySlug("posts", "hello");
		expect(entry?.data.featured_image).toBeFalsy();
	});

	it("should handle failed downloads gracefully", async () => {
		mockFetch.mockResolvedValueOnce(createMockResponse(new Uint8Array(), "", false, 404));

		const seed: SeedFile = {
			version: "1",
			content: {
				posts: [
					{
						id: "post-1",
						slug: "hello",
						data: {
							title: "Hello",
							featured_image: {
								$media: {
									url: "https://example.com/missing.png",
									alt: "Missing",
								},
							},
						},
					},
				],
			},
		};

		const result = await applySeed(db, seed, {
			includeContent: true,
			storage,
			baseUrl: "",
		});

		expect(result.media.skipped).toBe(1);
		expect(result.content.created).toBe(1);

		// Image field should be null/undefined (not resolved)
		const contentRepo = new ContentRepository(db);
		const entry = await contentRepo.findBySlug("posts", "hello");
		expect(entry?.data.featured_image).toBeFalsy();
	});

	it("should handle fetch errors gracefully", async () => {
		mockFetch.mockRejectedValueOnce(new Error("Network error"));

		const seed: SeedFile = {
			version: "1",
			content: {
				posts: [
					{
						id: "post-1",
						slug: "hello",
						data: {
							title: "Hello",
							featured_image: {
								$media: {
									url: "https://example.com/error.png",
									alt: "Error",
								},
							},
						},
					},
				],
			},
		};

		const result = await applySeed(db, seed, {
			includeContent: true,
			storage,
			baseUrl: "",
		});

		expect(result.media.skipped).toBe(1);
		expect(result.content.created).toBe(1);
	});

	it("should generate filename from URL when not specified", async () => {
		mockFetch.mockResolvedValueOnce(createMockResponse(MOCK_PNG, "image/png"));

		const seed: SeedFile = {
			version: "1",
			content: {
				posts: [
					{
						id: "post-1",
						slug: "hello",
						data: {
							title: "Hello",
							featured_image: {
								$media: {
									url: "https://example.com/path/to/beautiful-sunset.png?size=large",
									alt: "Sunset",
								},
							},
						},
					},
				],
			},
		};

		await applySeed(db, seed, {
			includeContent: true,
			storage,
			baseUrl: "",
		});

		// Check media record in database
		const media = await db.selectFrom("media").selectAll().executeTakeFirst();

		expect(media?.filename).toBe("beautiful-sunset.png");
	});

	it("should use specified filename", async () => {
		mockFetch.mockResolvedValueOnce(createMockResponse(MOCK_PNG, "image/png"));

		const seed: SeedFile = {
			version: "1",
			content: {
				posts: [
					{
						id: "post-1",
						slug: "hello",
						data: {
							title: "Hello",
							featured_image: {
								$media: {
									url: "https://example.com/random-id-12345.png",
									alt: "Custom",
									filename: "my-custom-name.png",
								},
							},
						},
					},
				],
			},
		};

		await applySeed(db, seed, {
			includeContent: true,
			storage,
			baseUrl: "",
		});

		const media = await db.selectFrom("media").selectAll().executeTakeFirst();

		expect(media?.filename).toBe("my-custom-name.png");
	});

	it("should create media record with correct metadata", async () => {
		mockFetch.mockResolvedValueOnce(createMockResponse(MOCK_PNG, "image/png"));

		const seed: SeedFile = {
			version: "1",
			content: {
				posts: [
					{
						id: "post-1",
						slug: "hello",
						data: {
							title: "Hello",
							featured_image: {
								$media: {
									url: "https://example.com/test.png",
									alt: "Test alt text",
									caption: "Test caption",
									filename: "test-image.png",
								},
							},
						},
					},
				],
			},
		};

		await applySeed(db, seed, {
			includeContent: true,
			storage,
			baseUrl: "",
		});

		const media = await db.selectFrom("media").selectAll().executeTakeFirst();

		expect(media).toMatchObject({
			filename: "test-image.png",
			mime_type: "image/png",
			alt: "Test alt text",
			caption: "Test caption",
			status: "ready",
		});
		expect(media?.storage_key).toMatch(PNG_EXTENSION_REGEX);
	});

	it("should resolve nested $media in arrays", async () => {
		// Set up a collection with a json field for gallery
		const registry = new SchemaRegistry(db);
		await registry.createField("posts", {
			slug: "gallery",
			label: "Gallery",
			type: "json",
		});

		mockFetch
			.mockResolvedValueOnce(createMockResponse(MOCK_PNG, "image/png"))
			.mockResolvedValueOnce(createMockResponse(MOCK_JPEG, "image/jpeg"));

		const seed: SeedFile = {
			version: "1",
			content: {
				posts: [
					{
						id: "post-1",
						slug: "hello",
						data: {
							title: "Hello",
							gallery: [
								{
									$media: {
										url: "https://example.com/one.png",
										alt: "Image one",
									},
								},
								{
									$media: {
										url: "https://example.com/two.jpg",
										alt: "Image two",
									},
								},
							],
						},
					},
				],
			},
		};

		const result = await applySeed(db, seed, {
			includeContent: true,
			storage,
			baseUrl: "",
		});

		expect(result.media.created).toBe(2);

		const contentRepo = new ContentRepository(db);
		const entry = await contentRepo.findBySlug("posts", "hello");

		expect(entry?.data.gallery).toHaveLength(2);
		// ImageValue stores id (URL is built at runtime by EmDashImage)
		const gallery = entry?.data.gallery as unknown[] | undefined;
		expect(gallery?.[0]).toMatchObject({
			id: expect.any(String),
			alt: "Image one",
		});
		expect(gallery?.[1]).toMatchObject({
			id: expect.any(String),
			alt: "Image two",
		});
	});
});
