import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import EmDashImage from "../../src/components/EmDashImage.astro";
import Gallery from "../../src/components/Gallery.astro";
import Image from "../../src/components/Image.astro";

const locals = {
	emdash: { getPublicMediaUrl: (key: string) => `/_emdash/api/media/file/${key}` },
};
const blurhash = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";

function styles(html: string): string[] {
	return Array.from(html.matchAll(/\bstyle="([^"]*)"/g), (m) => m[1]!.replaceAll("&quot;", '"'));
}

// Browsers drop a `background` shorthand whose size is not preceded by
// `<position> /`, so the image would load into an empty box.
function expectValidBlurhashBackground(style: string | undefined) {
	expect(style).toMatch(/^background: url\("data:image\/bmp;base64,[^"]+"\) [^;]*\/\s*cover\b/);
}

describe("blurhash placeholder background", () => {
	it("is valid CSS on the public Image component", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(EmDashImage, {
			props: { image: { id: "m1", src: "https://example.com/a.jpg", blurhash } },
			locals,
		});
		expectValidBlurhashBackground(styles(html)[0]);
	});

	it("is valid CSS on Portable Text images", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(Image, {
			props: {
				node: {
					_type: "image",
					_key: "k1",
					asset: { _ref: "m1", url: "https://example.com/a.jpg" },
					blurhash,
				},
			},
			locals,
		});
		expectValidBlurhashBackground(styles(html)[0]);
	});

	it("is valid CSS on gallery items", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(Gallery, {
			props: {
				node: {
					_type: "gallery",
					_key: "g1",
					images: [
						{
							_type: "image",
							_key: "i1",
							asset: { _ref: "m1", url: "https://example.com/a.jpg" },
							blurhash,
						},
					],
				},
			},
			locals,
		});
		const img = html.match(/<img\b[^>]*>/)?.[0] ?? "";
		const figure = html.match(/<figure\b[^>]*>/)?.[0] ?? "";
		expectValidBlurhashBackground(styles(img)[0]);
		expect(figure).not.toContain("style=");
	});

	it("is omitted when placeholders are disabled", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(EmDashImage, {
			props: {
				image: { id: "m1", src: "https://example.com/a.jpg", blurhash },
				placeholder: false,
			},
			locals,
		});
		expect(html).not.toContain("background");
	});

	it("keeps the dominant color fallback when there is no blurhash", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(EmDashImage, {
			props: {
				image: { id: "m1", src: "https://example.com/a.jpg", dominantColor: "#336699" },
			},
			locals,
		});
		expect(styles(html)[0]).toBe("background-color: #336699;");
	});
});
