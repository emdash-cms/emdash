import { describe, it, expect, vi } from "vitest";

import { normalizeMediaValue } from "../../../src/media/normalize.js";
import type { MediaProvider, MediaProviderItem } from "../../../src/media/types.js";

function mockProvider(getResult: MediaProviderItem | null = null): MediaProvider {
	return {
		list: vi.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
		get: vi.fn().mockResolvedValue(getResult),
		getEmbed: vi.fn().mockReturnValue({ type: "image", src: "/test" }),
	};
}

function getProvider(
	providers: Record<string, MediaProvider>,
): (id: string) => MediaProvider | undefined {
	return (id: string) => providers[id];
}

describe("normalizeMediaValue", () => {
	it("returns null for null input", async () => {
		const result = await normalizeMediaValue(null, getProvider({}));
		expect(result).toBeNull();
	});

	it("returns null for undefined input", async () => {
		const result = await normalizeMediaValue(undefined, getProvider({}));
		expect(result).toBeNull();
	});

	it("converts bare HTTP URL to external MediaValue", async () => {
		const result = await normalizeMediaValue("https://example.com/photo.jpg", getProvider({}));
		expect(result).toEqual({
			provider: "external",
			id: "",
			src: "https://example.com/photo.jpg",
		});
	});

	it("converts bare HTTPS URL to external MediaValue", async () => {
		const result = await normalizeMediaValue("http://example.com/photo.jpg", getProvider({}));
		expect(result).toEqual({
			provider: "external",
			id: "",
			src: "http://example.com/photo.jpg",
		});
	});

	it("converts bare local media ID to full local MediaValue when provider resolves it", async () => {
		const providerItem: MediaProviderItem = {
			id: "01KRZKN0BK219P9HBMPYYGYRHY",
			filename: "photo.png",
			mimeType: "image/png",
			width: 1024,
			height: 768,
			alt: "A photo",
			meta: { storageKey: "uploads/photo.png" },
		};
		const local = mockProvider(providerItem);

		const result = await normalizeMediaValue("01KRZKN0BK219P9HBMPYYGYRHY", getProvider({ local }));

		expect(local.get).toHaveBeenCalledWith("01KRZKN0BK219P9HBMPYYGYRHY");
		expect(result).toEqual({
			provider: "local",
			id: "01KRZKN0BK219P9HBMPYYGYRHY",
			filename: "photo.png",
			mimeType: "image/png",
			width: 1024,
			height: 768,
			alt: "A photo",
			meta: { storageKey: "uploads/photo.png" },
		});
	});

	it("converts bare internal media URL to full local MediaValue via provider", async () => {
		const providerItem: MediaProviderItem = {
			id: "01ABC",
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			width: 1200,
			height: 800,
			alt: "A photo",
			meta: { storageKey: "01ABC.jpg" },
		};
		const local = mockProvider(providerItem);

		const result = await normalizeMediaValue(
			"/_emdash/api/media/file/01ABC.jpg",
			getProvider({ local }),
		);

		expect(local.get).toHaveBeenCalledWith("01ABC.jpg");
		expect(result).toEqual({
			provider: "local",
			id: "01ABC",
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			width: 1200,
			height: 800,
			alt: "A photo",
			meta: { storageKey: "01ABC.jpg" },
		});
	});

	it("falls back to external for internal URL when local provider unavailable", async () => {
		const result = await normalizeMediaValue("/_emdash/api/media/file/01ABC.jpg", getProvider({}));
		expect(result).toEqual({
			provider: "external",
			id: "",
			src: "/_emdash/api/media/file/01ABC.jpg",
		});
	});

	it("falls back to external for internal URL when provider.get returns null", async () => {
		const local = mockProvider(null);
		const result = await normalizeMediaValue(
			"/_emdash/api/media/file/01ABC.jpg",
			getProvider({ local }),
		);
		expect(result).toEqual({
			provider: "external",
			id: "",
			src: "/_emdash/api/media/file/01ABC.jpg",
		});
	});

	it("fills missing dimensions from local provider", async () => {
		const providerItem: MediaProviderItem = {
			id: "01ABC",
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			width: 1200,
			height: 800,
			meta: { storageKey: "01ABC.jpg" },
		};
		const local = mockProvider(providerItem);

		const result = await normalizeMediaValue(
			{
				provider: "local",
				id: "01ABC",
				alt: "My photo",
				meta: { storageKey: "01ABC.jpg" },
			},
			getProvider({ local }),
		);

		expect(local.get).toHaveBeenCalledWith("01ABC");
		expect(result).toMatchObject({
			provider: "local",
			id: "01ABC",
			width: 1200,
			height: 800,
			alt: "My photo",
			meta: { storageKey: "01ABC.jpg" },
		});
	});

	it("fills missing storageKey from local provider", async () => {
		const providerItem: MediaProviderItem = {
			id: "01ABC",
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			width: 1200,
			height: 800,
			meta: { storageKey: "01ABC.jpg" },
		};
		const local = mockProvider(providerItem);

		const result = await normalizeMediaValue(
			{
				provider: "local",
				id: "01ABC",
				width: 1200,
				height: 800,
			},
			getProvider({ local }),
		);

		expect(local.get).toHaveBeenCalledWith("01ABC");
		expect(result).toMatchObject({
			provider: "local",
			id: "01ABC",
			meta: { storageKey: "01ABC.jpg" },
		});
	});

	it("fills missing mimeType and filename from local provider", async () => {
		const providerItem: MediaProviderItem = {
			id: "01ABC",
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			width: 1200,
			height: 800,
			meta: { storageKey: "01ABC.jpg" },
		};
		const local = mockProvider(providerItem);

		const result = await normalizeMediaValue(
			{
				provider: "local",
				id: "01ABC",
				width: 1200,
				height: 800,
				meta: { storageKey: "01ABC.jpg" },
			},
			getProvider({ local }),
		);

		expect(result).toMatchObject({
			filename: "photo.jpg",
			mimeType: "image/jpeg",
		});
	});

	it("fills dimensions from external provider", async () => {
		const providerItem: MediaProviderItem = {
			id: "cf-abc123",
			filename: "hero.jpg",
			mimeType: "image/jpeg",
			width: 1920,
			height: 1080,
			meta: { variants: ["public"] },
		};
		const cfImages = mockProvider(providerItem);

		const result = await normalizeMediaValue(
			{
				provider: "cloudflare-images",
				id: "cf-abc123",
				alt: "Hero banner",
				previewUrl: "https://imagedelivery.net/hash/cf-abc123/w=400",
			},
			getProvider({ "cloudflare-images": cfImages }),
		);

		expect(cfImages.get).toHaveBeenCalledWith("cf-abc123");
		expect(result).toMatchObject({
			provider: "cloudflare-images",
			id: "cf-abc123",
			width: 1920,
			height: 1080,
			alt: "Hero banner",
			previewUrl: "https://imagedelivery.net/hash/cf-abc123/w=400",
		});
	});

	it("still calls the provider to backfill LQIP for images even when dimensions are present", async () => {
		const cfImages = mockProvider(null);

		const value = {
			provider: "cloudflare-images",
			id: "cf-abc123",
			width: 1920,
			height: 1080,
			filename: "hero.jpg",
			mimeType: "image/jpeg",
			alt: "Hero banner",
			previewUrl: "https://imagedelivery.net/hash/cf-abc123/w=400",
			meta: { variants: ["public"] },
		};

		const result = await normalizeMediaValue(value, getProvider({ "cloudflare-images": cfImages }));

		// blurhash/dominantColor are missing → provider is consulted to backfill
		// them (e.g. records saved before LQIP, or rows that gained a blurhash
		// later). Provider.get returns null here, so the value is unchanged.
		expect(cfImages.get).toHaveBeenCalledWith("cf-abc123");
		expect(result).toEqual(value);
	});

	it("backfills blurhash and dominantColor from the provider when only LQIP is missing", async () => {
		const providerItem: MediaProviderItem = {
			id: "01ABC",
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			width: 1200,
			height: 800,
			blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
			dominantColor: "#112233",
			meta: { storageKey: "01ABC.jpg" },
		};
		const local = mockProvider(providerItem);

		// Fully populated article row except for LQIP — gain from finding #3:
		// the provider is now consulted so the blurhash backfill runs.
		const result = await normalizeMediaValue(
			{
				provider: "local",
				id: "01ABC",
				width: 1200,
				height: 800,
				filename: "photo.jpg",
				mimeType: "image/jpeg",
				meta: { storageKey: "01ABC.jpg" },
			},
			getProvider({ local }),
		);

		expect(local.get).toHaveBeenCalledWith("01ABC");
		expect(result).toMatchObject({
			blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
			dominantColor: "#112233",
		});
	});

	it("preserves caller alt over provider alt", async () => {
		const providerItem: MediaProviderItem = {
			id: "01ABC",
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			width: 1200,
			height: 800,
			alt: "Provider alt text",
			meta: { storageKey: "01ABC.jpg" },
		};
		const local = mockProvider(providerItem);

		const result = await normalizeMediaValue(
			{
				provider: "local",
				id: "01ABC",
				alt: "User alt text",
			},
			getProvider({ local }),
		);

		expect(result!.alt).toBe("User alt text");
	});

	it("uses provider alt when caller alt is not set", async () => {
		const providerItem: MediaProviderItem = {
			id: "01ABC",
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			width: 1200,
			height: 800,
			alt: "Provider alt text",
			meta: { storageKey: "01ABC.jpg" },
		};
		const local = mockProvider(providerItem);

		const result = await normalizeMediaValue(
			{
				provider: "local",
				id: "01ABC",
			},
			getProvider({ local }),
		);

		expect(result!.alt).toBe("Provider alt text");
	});

	it("returns value as-is for unknown provider", async () => {
		const value = {
			provider: "some-unknown-provider",
			id: "item-123",
			width: 800,
			height: 600,
			alt: "Some image",
		};

		const result = await normalizeMediaValue(value, getProvider({}));
		expect(result).toEqual(value);
	});

	it("does not fail when provider.get returns null", async () => {
		const local = mockProvider(null);

		const value = {
			provider: "local",
			id: "01ABC",
			alt: "My photo",
		};

		const result = await normalizeMediaValue(value, getProvider({ local }));
		expect(result).toEqual(value);
	});

	it("does not fail when provider has no get method", async () => {
		const local: MediaProvider = {
			list: vi.fn().mockResolvedValue({ items: [] }),
			getEmbed: vi.fn().mockReturnValue({ type: "image", src: "/test" }),
			// no get method
		};

		const value = {
			provider: "local",
			id: "01ABC",
			alt: "My photo",
		};

		const result = await normalizeMediaValue(value, getProvider({ local }));
		expect(result).toEqual(value);
	});

	it("returns external value with src as-is (no dimension detection)", async () => {
		const value = {
			provider: "external",
			id: "",
			src: "https://example.com/photo.jpg",
			alt: "A photo",
			width: 800,
			height: 600,
		};

		const result = await normalizeMediaValue(value, getProvider({}));
		expect(result).toEqual(value);
	});

	it("does not call provider for external values without dimensions", async () => {
		const value = {
			provider: "external",
			id: "",
			src: "https://example.com/photo.jpg",
			alt: "A photo",
		};

		const result = await normalizeMediaValue(value, getProvider({}));
		expect(result).toEqual(value);
	});

	it("strips src from local media values", async () => {
		const providerItem: MediaProviderItem = {
			id: "01ABC",
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			width: 1200,
			height: 800,
			meta: { storageKey: "01ABC.jpg" },
		};
		const local = mockProvider(providerItem);

		const result = await normalizeMediaValue(
			{
				provider: "local",
				id: "01ABC",
				src: "/_emdash/api/media/file/01ABC.jpg",
				alt: "My photo",
				width: 1200,
				height: 800,
				meta: { storageKey: "01ABC.jpg" },
			},
			getProvider({ local }),
		);

		// src should be removed for local media - it's derived at display time
		expect(result!.src).toBeUndefined();
	});

	it("defaults provider to local when not specified", async () => {
		const providerItem: MediaProviderItem = {
			id: "01ABC",
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			width: 1200,
			height: 800,
			meta: { storageKey: "01ABC.jpg" },
		};
		const local = mockProvider(providerItem);

		const result = await normalizeMediaValue({ id: "01ABC" }, getProvider({ local }));

		expect(result!.provider).toBe("local");
		expect(local.get).toHaveBeenCalledWith("01ABC");
	});

	it("copies blurhash and dominantColor from local provider to top-level", async () => {
		const providerItem: MediaProviderItem = {
			id: "01ABC",
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			width: 1200,
			height: 800,
			blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
			dominantColor: "#aabbcc",
			meta: { storageKey: "01ABC.jpg" },
		};
		const local = mockProvider(providerItem);

		// Missing filename/mimeType triggers the provider lookup.
		const result = await normalizeMediaValue(
			{
				provider: "local",
				id: "01ABC",
				width: 1200,
				height: 800,
				meta: { storageKey: "01ABC.jpg" },
			},
			getProvider({ local }),
		);

		expect(result).toMatchObject({
			provider: "local",
			id: "01ABC",
			blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
			dominantColor: "#aabbcc",
		});
	});

	it("copies blurhash and dominantColor when resolving a bare local media ID", async () => {
		const providerItem: MediaProviderItem = {
			id: "01ABC",
			filename: "photo.png",
			mimeType: "image/png",
			width: 1024,
			height: 768,
			blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
			dominantColor: "#112233",
			meta: { storageKey: "01ABC.png" },
		};
		const local = mockProvider(providerItem);

		const result = await normalizeMediaValue("01ABC", getProvider({ local }));

		expect(result).toMatchObject({
			provider: "local",
			id: "01ABC",
			blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
			dominantColor: "#112233",
		});
	});

	it("preserves caller-supplied blurhash over provider value", async () => {
		const providerItem: MediaProviderItem = {
			id: "01ABC",
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			width: 1200,
			height: 800,
			blurhash: "PROVIDER_HASH",
			dominantColor: "#000000",
			meta: { storageKey: "01ABC.jpg" },
		};
		const local = mockProvider(providerItem);

		const result = await normalizeMediaValue(
			{
				provider: "local",
				id: "01ABC",
				blurhash: "CALLER_HASH",
				dominantColor: "#ffffff",
			},
			getProvider({ local }),
		);

		expect(result!.blurhash).toBe("CALLER_HASH");
		expect(result!.dominantColor).toBe("#ffffff");
	});

	it("handles provider.get throwing gracefully", async () => {
		const local: MediaProvider = {
			list: vi.fn().mockResolvedValue({ items: [] }),
			get: vi.fn().mockRejectedValue(new Error("DB error")),
			getEmbed: vi.fn().mockReturnValue({ type: "image", src: "/test" }),
		};

		const value = {
			provider: "local",
			id: "01ABC",
			alt: "My photo",
		};

		const result = await normalizeMediaValue(value, getProvider({ local }));
		expect(result).toEqual(value);
	});
});
