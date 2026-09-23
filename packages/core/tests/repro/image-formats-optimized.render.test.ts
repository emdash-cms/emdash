/**
 * Exercises the Image component's manually rendered `<picture>` path: media
 * URLs optimized through `buildResponsiveImage`/`getImage` rather than the
 * same-origin `AstroPicture` path. `getImage` is stubbed to act like a real
 * image service (rewritten URL carrying the requested format), which the
 * container's passthrough service never does.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, test, vi } from "vitest";

import EmDashImage from "../../src/components/EmDashImage.astro";

vi.mock("astro:assets", async (importOriginal) => {
	const mod = await importOriginal<Record<string, unknown>>();
	return {
		...mod,
		getImage: vi.fn(
			async (opts: { src: string; width?: number; format?: string; sizes?: string }) => ({
				src: `/_image?href=${encodeURIComponent(opts.src)}&w=${opts.width}&f=${opts.format ?? "webp"}`,
				srcSet: {
					attribute: `/_image?href=${encodeURIComponent(opts.src)}&w=640&f=${opts.format ?? "webp"} 640w`,
				},
			}),
		),
	};
});

const locals = {
	emdash: { getPublicMediaUrl: (k: string) => `/_emdash/api/media/file/${k}` },
};

const imgTag = (html: string) => html.match(/<img\b[^>]*>/)?.[0] ?? "";
const sourceTags = (html: string) => html.match(/<source\b[^>]*>/g) ?? [];
const attr = (tag: string, name: string) =>
	tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]?.replaceAll("&amp;", "&");

// An authorized remote host: not same-origin, so the component optimizes it
// through getImage instead of delegating to AstroPicture.
const remoteImage = {
	id: "01REMOTE",
	src: "https://cdn.example.com/photo.jpg",
	alt: "Remote photo",
	width: 1232,
	height: 565,
};

async function render(props: Record<string, unknown>) {
	const c = await AstroContainer.create();
	return c.renderToString(EmDashImage, { props, locals });
}

describe("Image formats on the optimized (non-AstroPicture) path", () => {
	test("renders a <picture> whose source and img carry the requested formats", async () => {
		const html = await render({ image: remoteImage, formats: ["avif", "webp"] });

		expect(html).toContain("<picture");
		const sources = sourceTags(html);
		expect(sources).toHaveLength(1);
		expect(attr(sources[0]!, "type")).toBe("image/avif");
		expect(attr(sources[0]!, "srcset")).toContain("f=avif");
		expect(attr(sources[0]!, "sizes")).toBe("(min-width: 1232px) 1232px, 100vw");

		const img = imgTag(html);
		expect(attr(img, "src")).toContain("f=webp");
		expect(attr(img, "srcset")).toContain("f=webp");
	});

	test("a fallbackFormat listed in formats keeps that format as a source", async () => {
		const html = await render({
			image: remoteImage,
			formats: ["avif", "webp"],
			fallbackFormat: "avif",
		});

		const sources = sourceTags(html);
		expect(sources.map((s) => attr(s, "type"))).toEqual(["image/avif", "image/webp"]);
		expect(attr(sources[0]!, "srcset")).toContain("f=avif");
		expect(attr(imgTag(html), "src")).toContain("f=avif");
	});

	test("without formats the optimized path stays a single img", async () => {
		const html = await render({ image: remoteImage });

		expect(html).not.toContain("<picture");
		expect(attr(imgTag(html), "src")).toContain("/_image?");
	});
});
