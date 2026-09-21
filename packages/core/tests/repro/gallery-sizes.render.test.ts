/**
 * The gallery's `sizes` must describe a grid cell, not the viewport: each
 * image renders in one of `columns` cells (two at 640px and below), and a
 * `100vw` estimate lets the browser pick a far larger srcset candidate than
 * the cell needs (#2930).
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, test } from "vitest";

import Gallery from "../../src/components/Gallery.astro";

const testMediaProviders = [
	{
		id: "mock-gallery-images",
		name: "Mock Gallery Images",
		capabilities: { list: false, upload: false, delete: false, metadata: false },
		createProvider: () => ({
			id: "mock-gallery-images",
			name: "Mock Gallery Images",
			capabilities: { list: false, upload: false, delete: false, metadata: false },
			getEmbed: (_value: unknown, options: { width?: number; height?: number } = {}) => ({
				type: "image",
				src: `https://img.example.com/original?w=${options.width ?? "auto"}`,
				getSrc: ({ width, height }: { width?: number; height?: number } = {}) =>
					`https://img.example.com/render?w=${width ?? "auto"}&h=${height ?? "auto"}`,
			}),
		}),
	},
];

const providerGlobal = globalThis as typeof globalThis & {
	__emdashTestMediaProviders?: typeof testMediaProviders;
};
providerGlobal.__emdashTestMediaProviders = [
	...(providerGlobal.__emdashTestMediaProviders ?? []),
	...testMediaProviders,
];

const locals = {
	emdash: { getPublicMediaUrl: (k: string) => `/_emdash/api/media/file/${k}` },
};

const imgTags = (html: string) => html.match(/<img\b[^>]*>/g) ?? [];
const attr = (tag: string, name: string) =>
	tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]?.replaceAll("&amp;", "&");

function providerImage(key: string) {
	return {
		_type: "image" as const,
		_key: key,
		asset: { _ref: `provider-${key}`, provider: "mock-gallery-images" },
		alt: key,
		width: 1600,
		height: 1200,
	};
}

async function renderGallery(props: Record<string, unknown>) {
	const container = await AstroContainer.create();
	return container.renderToString(Gallery, { props, locals });
}

describe("Gallery sizes", () => {
	test("provider images are sized to one of three default columns", async () => {
		const html = await renderGallery({
			node: { _type: "gallery", _key: "g", images: [providerImage("a"), providerImage("b")] },
		});
		const tags = imgTags(html);

		expect(tags).toHaveLength(2);
		for (const tag of tags) {
			expect(attr(tag, "srcset")).toContain("https://img.example.com/render?w=640");
			expect(attr(tag, "sizes")).toBe(
				"(max-width: 640px) calc((100vw - 1rem) / 2), calc((100vw - 2rem) / 3)",
			);
		}
	});

	test("the slot follows the block's column count", async () => {
		const html = await renderGallery({
			node: { _type: "gallery", _key: "g", columns: 4, images: [providerImage("a")] },
		});

		expect(attr(imgTags(html)[0]!, "sizes")).toBe(
			"(max-width: 640px) calc((100vw - 1rem) / 2), calc((100vw - 3rem) / 4)",
		);
	});

	test("locally stored images with dimensions get the same cell estimate", async () => {
		const html = await renderGallery({
			node: {
				_type: "gallery",
				_key: "g",
				images: [
					{
						_type: "image",
						_key: "local",
						asset: { _ref: "media-1", url: "/_emdash/api/media/file/local.jpg" },
						alt: "local",
						width: 1600,
						height: 1200,
					},
				],
			},
		});
		const tag = imgTags(html)[0]!;

		expect(attr(tag, "data-astro-image")).toBe("constrained");
		expect(attr(tag, "sizes")).toBe(
			"(max-width: 640px) calc((100vw - 1rem) / 2), calc((100vw - 2rem) / 3)",
		);
	});

	test("a consumer-provided sizes wins", async () => {
		const html = await renderGallery({
			node: { _type: "gallery", _key: "g", images: [providerImage("a")] },
			sizes: "(max-width: 640px) 45vw, 220px",
		});

		expect(attr(imgTags(html)[0]!, "sizes")).toBe("(max-width: 640px) 45vw, 220px");
	});
});
