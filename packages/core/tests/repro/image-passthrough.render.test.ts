import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { getConfiguredImageService } from "astro:assets";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import EmDashImage from "../../src/components/EmDashImage.astro";
import Gallery from "../../src/components/Gallery.astro";
import Image from "../../src/components/Image.astro";

const source = "/_emdash/api/media/file/photo.jpg";
const image = { id: "photo", src: source, width: 1536, height: 1024, alt: "Landscape" };
const node = {
	_type: "image",
	_key: "photo",
	asset: { _ref: "photo", url: source },
	width: image.width,
	height: image.height,
	alt: image.alt,
	caption: "Landscape caption",
	dominantColor: "#123456",
};
const renderCases = [
	{ name: "public Image", component: EmDashImage, props: { image } },
	{ name: "Portable Text image", component: Image, props: { node } },
	{
		name: "Portable Text gallery",
		component: Gallery,
		props: {
			node: {
				_type: "gallery",
				_key: "gallery",
				columns: 2,
				images: [node, { ...node, _key: "second" }],
			},
		},
	},
];
const request = () => new Request("https://quality.example.com/article");
const attr = (tag: string, name: string) =>
	tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]?.replaceAll("&amp;", "&");

let originalService: Awaited<ReturnType<typeof getConfiguredImageService>>;
beforeEach(async () => {
	originalService = await getConfiguredImageService();
});
afterEach(() => {
	globalThis.astroAsset.imageService = originalService;
});

function usePassthroughService() {
	globalThis.astroAsset.imageService = {
		...originalService,
		getURL: (options) => (typeof options.src === "string" ? options.src : options.src.src),
	};
}

function expectPlainImage(tag: string, src: string) {
	expect(attr(tag, "srcset")).toBeUndefined();
	expect(attr(tag, "src")).toBe(src);
	expect(attr(tag, "sizes")).toBeUndefined();
	expect(attr(tag, "width")).toBe("1536");
	expect(attr(tag, "height")).toBe("1024");
	expect(attr(tag, "alt")).toBe("Landscape");
}

describe("image service passthrough", () => {
	test("public Image keeps both color schemes and priority without advertising nonexistent variants", async () => {
		usePassthroughService();
		const container = await AstroContainer.create();
		const html = await container.renderToString(EmDashImage, {
			props: {
				image: { ...image, darkVariant: { ...image, src: "/media/dark.jpg" } },
				priority: true,
				quality: 70,
				class: "hero",
				"data-testid": "hero",
			},
			request: request(),
		});
		const tags = html.match(/<img\b[^>]*>/g) ?? [];
		expect(tags).toHaveLength(2);
		expectPlainImage(tags[0]!, source);
		expectPlainImage(tags[1]!, "/media/dark.jpg");
		expect(attr(tags[0]!, "class")).toContain("emdash-image--light");
		expect(attr(tags[1]!, "class")).toContain("emdash-image--dark");
		for (const tag of tags) {
			expect(attr(tag, "loading")).toBe("eager");
			expect(attr(tag, "fetchpriority")).toBe("high");
			expect(attr(tag, "quality")).toBeUndefined();
			expect(attr(tag, "class")).toContain("hero");
			expect(attr(tag, "data-testid")).toBe("hero");
		}
	});

	test.each([
		{ formats: ["avif"] },
		{ formats: ["avif", "webp"] },
		{ formats: ["avif", "webp"], fallbackFormat: "jpeg" },
	])("formats %j fall back to plain images for both color schemes", async (formatProps) => {
		usePassthroughService();
		const container = await AstroContainer.create();
		const html = await container.renderToString(EmDashImage, {
			props: {
				image: { ...image, darkVariant: { ...image, src: "/media/dark.jpg" } },
				...formatProps,
				id: "hero",
				priority: true,
				quality: 70,
			},
			request: request(),
		});
		expect(html).not.toContain("<picture");
		expect(html).not.toContain("<source");
		const tags = html.match(/<img\b[^>]*>/g) ?? [];
		expect(tags).toHaveLength(2);
		expectPlainImage(tags[0]!, source);
		expectPlainImage(tags[1]!, "/media/dark.jpg");
		expect(attr(tags[0]!, "class")).toContain("emdash-image--light");
		expect(attr(tags[1]!, "class")).toContain("emdash-image--dark");
		expect(attr(tags[0]!, "id")).toBe("hero");
		expect(attr(tags[1]!, "id")).toBe("hero--dark");
		for (const tag of tags) {
			expect(attr(tag, "loading")).toBe("eager");
			expect(attr(tag, "fetchpriority")).toBe("high");
			expect(attr(tag, "formats")).toBeUndefined();
			expect(attr(tag, "fallbackFormat")).toBeUndefined();
			expect(attr(tag, "quality")).toBeUndefined();
		}
	});

	test.each([
		{ blockedFormat: "avif", failure: "passthrough" },
		{ blockedFormat: "avif", failure: "error" },
		{ blockedFormat: "jpeg", failure: "passthrough" },
		{ blockedFormat: "jpeg", failure: "error" },
	])(
		"dark variant $blockedFormat $failure does not advertise unavailable formats",
		async ({ blockedFormat, failure }) => {
			globalThis.astroAsset.imageService = {
				...originalService,
				getURL(options, config, logger) {
					const src = typeof options.src === "string" ? options.src : options.src.src;
					if (src.endsWith("/media/dark.jpg") && options.format === blockedFormat) {
						if (failure === "error") throw new Error("format unavailable");
						return src;
					}
					return originalService.getURL(options, config, logger);
				},
			};
			const container = await AstroContainer.create();
			const html = await container.renderToString(EmDashImage, {
				props: {
					image: { ...image, darkVariant: { ...image, src: "/media/dark.jpg" } },
					formats: ["avif", "webp"],
					fallbackFormat: "jpeg",
				},
				request: request(),
			});
			const pictures = html.match(/<picture\b[^>]*>[\s\S]*?<\/picture>/g) ?? [];
			expect(pictures).toHaveLength(1);
			expect(pictures[0]).toContain("emdash-image--light");
			expect(pictures[0]).not.toContain("dark.jpg");
			const tags = html.match(/<img\b[^>]*>/g) ?? [];
			expect(tags).toHaveLength(2);
			expectPlainImage(tags[1]!, "/media/dark.jpg");
			expect(attr(tags[1]!, "class")).toContain("emdash-image--dark");
		},
	);

	test("working formats retain distinct transformed candidates in both pictures", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(EmDashImage, {
			props: {
				image: { ...image, darkVariant: { ...image, src: "/media/dark.jpg" } },
				formats: ["avif", "webp"],
				fallbackFormat: "jpeg",
				quality: 70,
			},
			request: request(),
		});
		const pictures = html.match(/<picture\b[^>]*>[\s\S]*?<\/picture>/g) ?? [];
		expect(pictures).toHaveLength(2);
		for (const [i, picture] of pictures.entries()) {
			const original = i === 0 ? source : "/media/dark.jpg";
			const sources = picture.match(/<source\b[^>]*>/g) ?? [];
			expect(sources.map((tag) => attr(tag, "type"))).toEqual(["image/avif", "image/webp"]);
			const img = picture.match(/<img\b[^>]*>/)?.[0] ?? "";
			for (const [index, tag] of [...sources, img].entries()) {
				const expectedFormat = ["avif", "webp", "jpeg"][index];
				const candidates = attr(tag, "srcset")!
					.split(", ")
					.map((s) => s.split(" ")[0]!);
				expect(candidates.length).toBeGreaterThan(1);
				expect(new Set(candidates).size).toBe(candidates.length);
				expect(attr(tag, "sizes")).toBe("(min-width: 1536px) 1536px, 100vw");
				for (const candidate of candidates) {
					const url = new URL(candidate, "https://quality.example.com");
					expect(url.searchParams.get("href")).toBe(`https://quality.example.com${original}`);
					expect(url.searchParams.get("f")).toBe(expectedFormat);
					expect(url.searchParams.get("q")).toBe("70");
				}
			}
		}
	});

	test.each([undefined, { href: "/gallery", blank: true }])(
		"Portable Text image preserves its wrapper, link and placeholder (%j)",
		async (link) => {
			usePassthroughService();
			const container = await AstroContainer.create();
			const html = await container.renderToString(Image, {
				props: { node: { ...node, link } },
				request: request(),
			});
			const tag = html.match(/<img\b[^>]*>/)?.[0] ?? "";
			expectPlainImage(tag, source);
			expect(attr(tag, "loading")).toBe("lazy");
			expect(attr(tag, "style")).toContain("background-color: #123456");
			expect(html).toContain("<figure");
			expect(html).toContain("Landscape caption");
			if (link) expect(html).toContain('href="/gallery" target="_blank"');
		},
	);

	test("gallery cells omit no-op candidates while retaining captions and columns", async () => {
		usePassthroughService();
		const container = await AstroContainer.create();
		const { component, props } = renderCases[2]!;
		const html = await container.renderToString(component, { props, request: request() });
		const tags = html.match(/<img\b[^>]*>/g) ?? [];
		expect(tags).toHaveLength(2);
		for (const tag of tags) expectPlainImage(tag, source);
		expect(html).toContain("--columns: 2");
		expect(html).toContain("Landscape caption");
	});

	test.each(renderCases)(
		"$name: unauthorized same-origin URLs do not advertise variants",
		async ({ component, props }) => {
			const container = await AstroContainer.create();
			const html = await container.renderToString(component, {
				props,
				request: new Request("https://unauthorized.example.com/article"),
			});
			expectPlainImage(html.match(/<img\b[^>]*>/)?.[0] ?? "", source);
		},
	);

	test.each(renderCases)(
		"$name: service errors fall back to the original image",
		async ({ component, props }) => {
			globalThis.astroAsset.imageService = {
				...originalService,
				getURL() {
					throw new Error("service unavailable");
				},
			};
			const container = await AstroContainer.create();
			const html = await container.renderToString(component, {
				props,
				request: request(),
			});
			expectPlainImage(html.match(/<img\b[^>]*>/)?.[0] ?? "", source);
		},
	);

	test.each(renderCases)(
		"$name: real optimization retains distinct responsive URLs",
		async ({ component, props }) => {
			const container = await AstroContainer.create();
			const html = await container.renderToString(component, {
				props,
				request: request(),
			});
			const tag = html.match(/<img\b[^>]*>/)?.[0] ?? "";
			expect(attr(tag, "src")).toContain("/_image?");
			expect(attr(tag, "data-astro-image")).toBe("constrained");
			const candidates = attr(tag, "srcset")!
				.split(", ")
				.map((s) => s.split(" ")[0]);
			expect(candidates.length).toBeGreaterThan(1);
			expect(new Set(candidates).size).toBe(candidates.length);
		},
	);
});
