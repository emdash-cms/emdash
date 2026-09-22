import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { expect, it } from "vitest";

import EmDashImage from "../../src/components/EmDashImage.astro";
import Gallery from "../../src/components/Gallery.astro";

const locals = {
	emdash: { getPublicMediaUrl: (key: string) => `/_emdash/api/media/file/${key}` },
};

it("applies a media snapshot focal point to the public Image component", async () => {
	const container = await AstroContainer.create();
	const html = await container.renderToString(EmDashImage, {
		props: {
			image: {
				id: "media-1",
				src: "https://example.com/portrait.jpg",
				focalX: 0.25,
				focalY: 0.75,
			},
			class: "cover-image",
		},
		locals,
	});

	expect(html).toContain("object-position: 25% 75%");
});

it("lets an explicit Image style override the stored focal point", async () => {
	const container = await AstroContainer.create();
	const html = await container.renderToString(EmDashImage, {
		props: {
			image: {
				id: "media-1",
				src: "https://example.com/portrait.jpg",
				focalX: 0.25,
				focalY: 0.75,
			},
			style: "object-position: 10% 20%;",
		},
		locals,
	});

	expect(html).toContain("object-position: 10% 20%");
	expect(html).not.toContain("object-position: 25% 75%");
});

it("ignores an incomplete content focal point", async () => {
	const container = await AstroContainer.create();
	const html = await container.renderToString(EmDashImage, {
		props: {
			image: {
				id: "media-1",
				src: "https://example.com/portrait.jpg",
				focalX: 0.25,
			},
		},
		locals,
	});

	expect(html).not.toContain("object-position");
});

it("applies each gallery image focal point to its square crop", async () => {
	const container = await AstroContainer.create();
	const html = await container.renderToString(Gallery, {
		props: {
			node: {
				_type: "gallery",
				_key: "gallery-1",
				images: [
					{
						_type: "image",
						_key: "image-1",
						asset: { _ref: "media-1", url: "/_emdash/api/media/file/portrait.jpg" },
						alt: "Portrait",
						focalX: 0.2,
						focalY: 0.8,
					},
				],
			},
		},
		locals,
	});

	expect(html).toContain("object-position: 20% 80%");
});
