import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { expect, it } from "vitest";

import EmDashImage from "../../src/components/EmDashImage.astro";
import Gallery from "../../src/components/Gallery.astro";
import Image from "../../src/components/Image.astro";

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

it("keeps both the blurhash placeholder and the focal point as separate declarations", async () => {
	const container = await AstroContainer.create();
	const html = await container.renderToString(EmDashImage, {
		props: {
			image: {
				id: "media-1",
				src: "https://example.com/portrait.jpg",
				blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
				focalX: 0.35,
				focalY: 0.65,
			},
		},
		locals,
	});

	const styleMatch = html.match(/\bstyle="([^"]*)"/);
	expect(styleMatch).toBeTruthy();
	const style = styleMatch?.[1].replaceAll("&quot;", '"') ?? "";

	expect(style).toMatch(
		/^background-image: url\("data:image\/bmp;base64,[^"]+"\); background-size: cover;/,
	);
	expect(style).toContain("object-position: 35% 65%");
	expect(style).not.toContain("cover object-position");
});

it.each([
	[
		"EmDashImage",
		EmDashImage,
		{
			image: {
				id: "m",
				src: "https://example.com/a.jpg",
				blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
			},
		},
	],
	[
		"Image",
		Image,
		{
			node: {
				_type: "image",
				_key: "k",
				asset: { _ref: "m", url: "https://example.com/a.jpg" },
				blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
			},
		},
	],
	[
		"Gallery",
		Gallery,
		{
			node: {
				_type: "gallery",
				_key: "g",
				images: [
					{
						_type: "image",
						_key: "k",
						asset: { _ref: "m", url: "https://example.com/a.jpg" },
						blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
					},
				],
			},
		},
	],
])("%s renders the blurhash placeholder as valid longhand CSS", async (_name, Component, props) => {
	const container = await AstroContainer.create();
	const html = (await container.renderToString(Component, { props, locals })).replaceAll(
		"&quot;",
		'"',
	);

	expect(html).toMatch(
		/background-image: url\("data:image\/bmp;base64,[^"]+"\); background-size: cover;/,
	);
	expect(html).not.toMatch(/background: url\([^)]*\) cover/);
});

it("puts the gallery placeholder on the image, not behind its caption", async () => {
	const container = await AstroContainer.create();
	const html = (
		await container.renderToString(Gallery, {
			props: {
				node: {
					_type: "gallery",
					_key: "g",
					images: [
						{
							_type: "image",
							_key: "k",
							asset: { _ref: "m", url: "https://example.com/a.jpg" },
							caption: "A caption",
							blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
							focalX: 0.2,
							focalY: 0.8,
						},
					],
				},
			},
			locals,
		})
	).replaceAll("&quot;", '"');

	expect(html).toMatch(/<figure class="emdash-gallery-item"[^>]*>/);
	expect(html).not.toMatch(/<figure[^>]*style=/);
	expect(html).toMatch(
		/<img[^>]*style="background-image: url\("data:image\/bmp;base64,[^"]+"\); background-size: cover; object-position: 20% 80%;"/,
	);
	expect(html).toContain("<figcaption");
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
