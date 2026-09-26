import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Storage } from "../../../src/storage/types.js";

const astroAssets = vi.hoisted(() => ({
	service: {} as Record<string, unknown>,
	imageConfig: {
		service: { entrypoint: "astro/assets/services/sharp", config: {} },
		endpoint: { route: "/_image", entrypoint: "emdash/image-endpoint" },
	},
}));

vi.mock(
	"astro:assets",
	() => ({
		getConfiguredImageService: async () => astroAssets.service,
		imageConfig: astroAssets.imageConfig,
	}),
	{ virtual: true },
);

import {
	configuredImageServiceSupportsHeic,
	resolveStorageImageSource,
} from "../../../src/astro/image-service.js";

const storage = {
	getPublicUrl: (key: string) => `https://media.example.com/${key}`,
} as Storage;

describe("resolveStorageImageSource", () => {
	it("rejects the authenticated media fallback as an external-service source", () => {
		expect(
			resolveStorageImageSource(
				{
					getPublicUrl: (key: string) => `/_emdash/api/media/file/${key}`,
				},
				"photo.heic",
				"https://site.example.com/_image",
			),
		).toBeNull();
	});
});

describe("configuredImageServiceSupportsHeic", () => {
	beforeEach(() => {
		astroAssets.imageConfig.service.entrypoint = "astro/assets/services/sharp";
		astroAssets.imageConfig.service.config = {};
		astroAssets.imageConfig.endpoint.entrypoint = "emdash/image-endpoint";
		astroAssets.service = {};
	});

	it("accepts an external service that declares HEIC input and rewrites the storage URL", async () => {
		astroAssets.imageConfig.service.entrypoint = "cloudinary-astro/service";
		astroAssets.imageConfig.service.config = { supportedInputFormats: ["heic"] };
		astroAssets.service = {
			getURL: async ({ src }: { src: string }) => `https://res.cloudinary.com/demo/${src}`,
		};

		await expect(
			configuredImageServiceSupportsHeic(storage, "https://site.example.com/_emdash/admin"),
		).resolves.toBe(true);
	});

	it("rejects an external service that rewrites HEIC without declaring input support", async () => {
		astroAssets.imageConfig.service.entrypoint = "custom-external";
		astroAssets.service = {
			getURL: async ({ src }: { src: string }) => `https://images.example.com/${src}`,
		};

		await expect(
			configuredImageServiceSupportsHeic(storage, "https://site.example.com/_emdash/admin"),
		).resolves.toBe(false);
	});

	it("rejects a local service and an external passthrough service", async () => {
		astroAssets.service = { transform: async () => ({ data: new Uint8Array(), format: "webp" }) };
		await expect(
			configuredImageServiceSupportsHeic(storage, "https://site.example.com"),
		).resolves.toBe(false);

		astroAssets.imageConfig.service.entrypoint = "custom-external";
		astroAssets.service = { getURL: async ({ src }: { src: string }) => src };
		await expect(
			configuredImageServiceSupportsHeic(storage, "https://site.example.com"),
		).resolves.toBe(false);
	});

	it("keeps the Cloudflare Images binding capable despite its local service stub", async () => {
		astroAssets.imageConfig.service.entrypoint = "@astrojs/cloudflare/image-service-workerd";
		astroAssets.imageConfig.endpoint.entrypoint = "@emdash-cms/cloudflare/image-endpoint";
		astroAssets.service = { transform: async () => ({ data: new Uint8Array(), format: "webp" }) };

		await expect(
			configuredImageServiceSupportsHeic(storage, "https://site.example.com"),
		).resolves.toBe(true);
	});

	it("rejects the Cloudflare workerd stub when the runtime endpoint is passthrough", async () => {
		astroAssets.imageConfig.service.entrypoint = "@astrojs/cloudflare/image-service-workerd";
		astroAssets.imageConfig.endpoint.entrypoint = "@astrojs/cloudflare/image-passthrough-endpoint";
		astroAssets.service = { transform: async () => ({ data: new Uint8Array(), format: "webp" }) };

		await expect(
			configuredImageServiceSupportsHeic(storage, "https://site.example.com"),
		).resolves.toBe(false);
	});
});
