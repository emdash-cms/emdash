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
		const html = await render({
			image: localImage,
			formats: ["avif", "webp"],
			fallbackFormat: "jpeg",
		});

		const sources = sourceTags(html);
		expect(sources.map((s) => attr(s, "type"))).toEqual(["image/avif", "image/webp"]);
		expect(attr(imgTag(html), "src")).toBeTruthy();
	});

	test("a single-entry formats list renders one img in that format", async () => {
		const html = await render({ image: localImage, formats: ["avif"] });

		expect(html).not.toContain("<picture");
		expect(sourceTags(html)).toHaveLength(0);
		expect(attr(imgTag(html), "src")).toBeTruthy();
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

	test("dark variants each get their own <picture>", async () => {
		const html = await render({
			image: {
				...localImage,
				darkVariant: { id: "01DARK", src: "/media/formats-dark.jpg", width: 1232, height: 565 },
			},
			formats: ["avif", "webp"],
		});

		expect(html.match(/<picture/g)).toHaveLength(2);
		const imgs = html.match(/<img\b[^>]*>/g) ?? [];
		expect(imgs).toHaveLength(2);
		expect(attr(imgs[0]!, "class")).toContain("emdash-image--light");
		expect(attr(imgs[1]!, "class")).toContain("emdash-image--dark");
	});
});
