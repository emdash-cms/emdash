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
