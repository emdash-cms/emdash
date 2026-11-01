import type { ExternalImageService, ImageTransform } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";

const assets = vi.hoisted(() => ({
	service: {} as ExternalImageService,
	imageConfig: {},
	genericGET: vi.fn(() => Promise.resolve(new Response("generic", { status: 500 }))),
}));

vi.mock("astro:assets", () => ({
	getConfiguredImageService: async () => assets.service,
	imageConfig: assets.imageConfig,
}));
vi.mock("astro/assets/endpoint/generic", () => ({ GET: assets.genericGET }));

import { GET } from "../../../src/astro/image-endpoint.js";

const download = vi.fn();
const getPublicUrl = vi.fn((key: string) => `https://media.example.com/${key}`);

function context(query: Record<string, string> = {}): Parameters<typeof GET>[0] {
	const params = new URLSearchParams({
		href: "https://site.example.com/_emdash/api/media/file/photo.heic",
		w: "400",
		f: "webp",
		...query,
	});
	const request = new Request(`https://site.example.com/_image?${params}`);
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal route context
	return {
		request,
		url: new URL(request.url),
		logger: console,
		locals: { emdash: { storage: { getPublicUrl, download } } },
	} as unknown as Parameters<typeof GET>[0];
}

function renditionUrl({ src, width, height, format, quality }: ImageTransform): string {
	return `https://images.example.com/transform?${new URLSearchParams({
		src: typeof src === "string" ? src : src.src,
		width: String(width),
		height: String(height),
		format: String(format),
		quality: String(quality),
	})}`;
}

describe("storage images with an external Astro image service", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getPublicUrl.mockImplementation((key) => `https://media.example.com/${key}`);
		assets.service = { getURL: renditionUrl };
	});

	it("redirects HEIC to a WebP rendition of the public storage source", async () => {
		const response = await GET(context({ h: "300", q: "80" }));

		expect(response.status).toBe(302);
		const destination = new URL(response.headers.get("Location")!);
		expect(destination.origin).toBe("https://images.example.com");
		expect(Object.fromEntries(destination.searchParams)).toEqual({
			src: "https://media.example.com/photo.heic",
			width: "400",
			height: "300",
			format: "webp",
			quality: "80",
		});
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
		expect(download).not.toHaveBeenCalled();
		expect(assets.genericGET).not.toHaveBeenCalled();
	});

	it("uses options normalized by the configured service", async () => {
		assets.service.validateOptions = async (options) => ({ ...options, quality: 75 });
		const response = await GET(context());
		expect(new URL(response.headers.get("Location")!).searchParams.get("quality")).toBe("75");
	});

	it("keeps replacement versions in the public source URL", async () => {
		getPublicUrl.mockReturnValue("https://media.example.com/photo.jpg?token=public");
		const response = await GET(
			context({
				href: "/_emdash/api/media/file/photo.jpg?_emdash_media=sha256%3Anew",
			}),
		);
		const destination = new URL(response.headers.get("Location")!);
		expect(destination.searchParams.get("src")).toBe(
			"https://media.example.com/photo.jpg?token=public&_emdash_media=sha256%3Anew",
		);
	});

	it.each([
		"/_emdash/api/media/file/photo.heic",
		"https://site.example.com/_emdash/api/media/file/photo.heic",
		"file:///uploads/photo.heic",
	])("keeps a private storage source out of the external service: %s", async (source) => {
		getPublicUrl.mockReturnValue(source);
		const getURL = vi.fn(renditionUrl);
		assets.service = { getURL };
		const response = await GET(context());
		expect(response.status).toBe(500);
		expect(await response.text()).toBe("generic");
		expect(getURL).not.toHaveBeenCalled();
		expect(download).not.toHaveBeenCalled();
	});

	it("resolves relative public sources and relative service URLs against the site", async () => {
		getPublicUrl.mockReturnValue("/uploads/photo.heic");
		assets.service.getURL = ({ src }) =>
			`/cdn-cgi/image/width=400/${typeof src === "string" ? src : src.src}`;
		const response = await GET(context());
		expect(response.headers.get("Location")).toBe(
			"https://site.example.com/cdn-cgi/image/width=400/https://site.example.com/uploads/photo.heic",
		);
	});

	it.each(["javascript:alert(1)", "data:image/svg+xml,<svg/>", "/_image?src=photo.heic"])(
		"rejects unsafe or recursive redirect destinations: %s",
		async (destination) => {
			assets.service.getURL = () => destination;
			const response = await GET(context());
			expect(response.status).toBe(500);
			expect(response.headers.has("Location")).toBe(false);
		},
	);

	it("rejects invalid transform dimensions before calling the service", async () => {
		const getURL = vi.fn(renditionUrl);
		assets.service = { getURL };
		const response = await GET(context({ w: "4001" }));
		expect(response.status).toBe(400);
		expect(getURL).not.toHaveBeenCalled();
	});

	it("delegates unrelated images to Astro's endpoint", async () => {
		const response = await GET(context({ href: "/_astro/photo.png" }));
		expect(await response.text()).toBe("generic");
		expect(getPublicUrl).not.toHaveBeenCalled();
	});

	it.each(["validateOptions", "getURL"] as const)(
		"handles %s failures without exposing service errors",
		async (method) => {
			assets.service[method] = () => {
				throw new Error("private service details");
			};
			const log = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				const response = await GET(context());
				expect(response.status).toBe(500);
				expect(response.headers.has("Location")).toBe(false);
				expect(await response.text()).toBe("Internal Server Error");
			} finally {
				log.mockRestore();
			}
		},
	);
});
