/**
 * Galleries seeded with `$media` store each image asset as a MediaValue
 * (`id`, `meta.storageKey`) rather than a `_ref`/`url` reference. The media id
 * is not a storage key, so the image must be served by its storage key.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, test } from "vitest";

import Gallery from "../../src/components/Gallery.astro";

const locals = {
	emdash: { getPublicMediaUrl: (key: string) => `https://cdn.example.com/${key}` },
};

describe("Gallery with seeded $media assets", () => {
	test("serves local images by their storage key", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(Gallery, {
			props: {
				node: {
					_type: "gallery",
					_key: "g",
					images: [
						{
							_type: "image",
							_key: "img1",
							asset: {
								provider: "local",
								id: "01M2QZRZTZPBJ2WV8A3B61ZZX7",
								alt: "A photo",
								meta: { storageKey: "01M2QZRZR8HDNT3039QNQ95B9D.jpg" },
							},
						},
					],
				},
			},
			locals,
		});

		const tag = html.match(/<img\b[^>]*>/)?.[0] ?? "";
		expect(tag).toContain('src="https://cdn.example.com/01M2QZRZR8HDNT3039QNQ95B9D.jpg"');
		expect(tag).toContain('alt="A photo"');
	});
});
