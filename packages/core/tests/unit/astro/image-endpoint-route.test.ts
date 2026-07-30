import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";

const assets = vi.hoisted(() => ({
	service: {} as Record<string, unknown>,
	imageConfig: {
		service: { entrypoint: "custom-external", config: {} },
		endpoint: { route: "/_image" },
	},
	genericGET: vi.fn(),
}));

vi.mock(
	"astro:assets",
	() => ({
		getConfiguredImageService: async () => assets.service,
		imageConfig: assets.imageConfig,
	}),
	{ virtual: true },
);
vi.mock("astro/assets/endpoint/generic", () => ({ GET: assets.genericGET }), { virtual: true });

import { GET } from "../../../src/astro/image-endpoint.js";

function context(key: string, storage: Record<string, unknown>): APIContext {
	const href = `https://site.example.com/_emdash/api/media/file/${key}`;
	const request = new Request(
		`https://site.example.com/_image?href=${encodeURIComponent(href)}&w=400&f=webp`,
	);
	return {
		request,
		url: new URL(request.url),
		params: {},
		locals: { emdash: { storage } },
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal route context
	} as unknown as APIContext;
}

describe("storage-backed Node image endpoint", () => {
	beforeEach(() => {
		assets.genericGET.mockReset();
		assets.imageConfig.service.entrypoint = "custom-external";
		assets.imageConfig.service.config = {};
	});

	it("redirects storage media through the configured external image service", async () => {
		assets.imageConfig.service.config = { supportedInputFormats: ["heic"] };
		assets.service = {
			getURL: async ({ src, width }: { src: string; width: number }) =>
				`https://images.example.com/w_${width}/${src}`,
		};
		const download = vi.fn();

		const response = await GET(
			context("photo.heic", {
				getPublicUrl: (key: string) => `https://media.example.com/${key}`,
				download,
			}),
		);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(
			"https://images.example.com/w_400/https://media.example.com/photo.heic",
		);
		expect(download).not.toHaveBeenCalled();
		expect(assets.genericGET).not.toHaveBeenCalled();
	});

	it("reports HEIC as unsupported when an external service rewrites without declaring support", async () => {
		assets.service = {
			getURL: async ({ src }: { src: string }) => `https://images.example.com/${src}`,
		};
		const download = vi.fn();

		const response = await GET(
			context("photo.heic", {
				getPublicUrl: (key: string) => `https://media.example.com/${key}`,
				download,
			}),
		);

		expect(response.status).toBe(415);
		expect(download).not.toHaveBeenCalled();
	});

	it("reports HEIC as unsupported when an external service passes it through", async () => {
		assets.service = { getURL: async ({ src }: { src: string }) => src };
		const download = vi.fn();

		const response = await GET(
			context("photo.heic", {
				getPublicUrl: (key: string) => `https://media.example.com/${key}`,
				download,
			}),
		);

		expect(response.status).toBe(415);
		expect(download).not.toHaveBeenCalled();
	});
});
