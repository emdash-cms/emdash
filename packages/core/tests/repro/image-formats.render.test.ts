/**
 * Renders the public Image component with the `formats` prop and pins the
 * `<picture>` output: source order, MIME types, fallback format, and the
 * paths where `formats` must not change the markup.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, test } from "vitest";

import EmDashImage from "../../src/components/EmDashImage.astro";

const locals = {
	emdash: { getPublicMediaUrl: (k: string) => `/_emdash/api/media/file/${k}` },
};

const imgTag = (html: string) => html.match(/<img\b[^>]*>/)?.[0] ?? "";
const sourceTags = (html: string) => html.match(/<source\b[^>]*>/g) ?? [];
const attr = (tag: string, name: string) =>
	tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]?.replaceAll("&amp;", "&");

async function render(props: Record<string, unknown>) {
	const c = await AstroContainer.create();
	return c.renderToString(EmDashImage, { props, locals });
}

// An allowed image domain, so the image service rewrites the URLs.
async function renderOptimized(props: Record<string, unknown>) {
	const c = await AstroContainer.create();
	return c.renderToString(EmDashImage, {
		props,
		locals,
		request: new Request("https://quality.example.com/"),
	});
}

const format = (url: string | undefined) =>
	new URL(url ?? "", "https://example.com").searchParams.get("f");

const localImage = {
	id: "01FORMATS",
	src: "/media/formats-test.jpg",
	alt: "Format test",
	width: 1232,
	height: 565,
};

describe("Image formats prop", () => {
	test("two formats render a <picture> with an AVIF source and a WebP img", async () => {
		const html = await render({ image: localImage, formats: ["avif", "webp"] });

		expect(html).toContain("<picture");
		const sources = sourceTags(html);
		expect(sources).toHaveLength(1);
		expect(attr(sources[0]!, "type")).toBe("image/avif");
		expect(attr(sources[0]!, "srcset")).toBeTruthy();

		const img = imgTag(html);
		expect(attr(img, "src")).toBeTruthy();
		expect(attr(img, "alt")).toBe("Format test");
		expect(attr(img, "width")).toBe("1232");
		expect(attr(img, "height")).toBe("565");
	});

	test("fallbackFormat overrides the img format and keeps all formats as sources", async () => {
		const html = await renderOptimized({
			image: localImage,
			formats: ["avif", "webp"],
			fallbackFormat: "jpeg",
		});

		const sources = sourceTags(html);
		expect(sources.map((s) => attr(s, "type"))).toEqual(["image/avif", "image/webp"]);
		expect(format(attr(imgTag(html), "src"))).toBe("jpeg");
	});

	test("a single-entry formats list renders one img in that format", async () => {
		const html = await renderOptimized({ image: localImage, formats: ["avif"] });

		expect(html).not.toContain("<picture");
		expect(sourceTags(html)).toHaveLength(0);
		expect(format(attr(imgTag(html), "src"))).toBe("avif");
	});

	test("without formats the markup is a single img, unchanged", async () => {
		const html = await render({ image: localImage });

		expect(html).not.toContain("<picture");
		expect(sourceTags(html)).toHaveLength(0);
		expect(attr(imgTag(html), "src")).toBeTruthy();
	});

	test("formats are ignored for images the service cannot optimize", async () => {
		const html = await render({
			image: "https://cdn.example.com/photo.jpg",
			alt: "CDN photo",
			width: 640,
			height: 360,
			formats: ["avif", "webp"],
		});

		expect(html).not.toContain("<picture");
		expect(attr(imgTag(html), "src")).toBe("https://cdn.example.com/photo.jpg");
	});

	test("sources carry the same sizes as the img, for both color schemes", async () => {
		const html = await render({
			image: {
				...localImage,
				darkVariant: { id: "01DARK", src: "/media/formats-dark.jpg", width: 1232, height: 565 },
			},
			formats: ["avif", "webp"],
		});

		const sources = sourceTags(html);
		const imgs = html.match(/<img\b[^>]*>/g) ?? [];
		expect(sources).toHaveLength(2);
		expect(imgs).toHaveLength(2);
		for (const [i, source] of sources.entries()) {
			expect(attr(source, "sizes")).toBe("(min-width: 1232px) 1232px, 100vw");
			expect(attr(source, "sizes")).toBe(attr(imgs[i]!, "sizes"));
		}
	});

	test("quality applies to the source and the img", async () => {
		const html = await renderOptimized({
			image: localImage,
			formats: ["avif", "webp"],
			quality: 70,
		});

		const [source] = sourceTags(html);
		const urls = [
			attr(imgTag(html), "src")!,
			...attr(source!, "srcset")!
				.split(", ")
				.map((candidate) => candidate.split(" ")[0]!),
		];
		for (const url of urls) {
			expect(new URL(url, "https://example.com").searchParams.get("q")).toBe("70");
		}
	});

	test("dark variants each get their own <picture>", async () => {
		const html = await render({
			image: {
				...localImage,
				darkVariant: { id: "01DARK", src: "/media/formats-dark.jpg", width: 1232, height: 565 },
			},
			formats: ["avif", "webp"],
		});

		const pictures = html.match(/<picture\b[^>]*>/g) ?? [];
		expect(pictures).toHaveLength(2);
		expect(attr(pictures[0]!, "class")).toContain("emdash-image--light");
		expect(attr(pictures[1]!, "class")).toContain("emdash-image--dark");
		const imgs = html.match(/<img\b[^>]*>/g) ?? [];
		expect(imgs).toHaveLength(2);
		expect(attr(imgs[0]!, "class")).toContain("emdash-image--light");
		expect(attr(imgs[1]!, "class")).toContain("emdash-image--dark");
	});

	test("a caller-supplied sizes reaches the source", async () => {
		const html = await render({ image: localImage, formats: ["avif", "webp"], sizes: "140px" });

		expect(attr(sourceTags(html)[0]!, "sizes")).toBe("140px");
		expect(attr(imgTag(html), "sizes")).toBe("140px");
	});
});
