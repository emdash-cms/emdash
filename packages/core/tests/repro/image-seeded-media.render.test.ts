/**
 * Image blocks seeded with `$media` by earlier versions store a MediaValue
 * (`id`, `meta.storageKey`); the media id is not a storage key.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, test } from "vitest";

import Image from "../../src/components/Image.astro";

const locals = {
	emdash: { getPublicMediaUrl: (key: string) => `https://cdn.example.com/${key}` },
};

describe("Image with a seeded $media asset", () => {
	test("serves a local image by its storage key", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(Image, {
			props: {
				node: {
					_type: "image",
					_key: "img1",
					asset: {
						provider: "local",
						id: "01M2QZRZTZPBJ2WV8A3B61ZZX7",
						alt: "A photo",
						mimeType: "image/jpeg",
						meta: { storageKey: "01M2QZRZR8HDNT3039QNQ95B9D.jpg" },
					},
					caption: "A caption",
				},
			},
			locals,
		});

		const tag = html.match(/<img\b[^>]*>/)?.[0] ?? "";
		expect(tag).toContain('src="https://cdn.example.com/01M2QZRZR8HDNT3039QNQ95B9D.jpg"');
		expect(tag).toContain('alt="A photo"');
	});
});
