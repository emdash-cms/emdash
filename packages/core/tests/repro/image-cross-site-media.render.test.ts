/**
 * EmDash's image endpoint reads media URLs from this site's storage, so only
 * this site's media URLs may be handed to the image service. `getImage` is
 * stubbed to act like a real image service, which the container's passthrough
 * service never does.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, test, vi } from "vitest";

import EmDashImage from "../../src/components/EmDashImage.astro";
import Gallery from "../../src/components/Gallery.astro";
import Image from "../../src/components/Image.astro";

vi.mock("astro:assets", async (importOriginal) => {
	const mod = await importOriginal<Record<string, unknown>>();
	return {
		...mod,
		getImage: vi.fn(async (opts?: { src?: string; width?: number }) => ({
			src: `/_image?href=${encodeURIComponent(opts?.src ?? "")}&w=${opts?.width}`,
			srcSet: { attribute: "" },
			attributes: {},
			options: opts ?? {},
		})),
	};
});

const { getImage } = await import("astro:assets");
const OTHER_SITE = "https://other.example/_emdash/api/media/file/01OTHER.jpg";
const OWN_MEDIA = "/_emdash/api/media/file/01OWN.jpg";
const locals = { emdash: {} };

const ptImage = (url: string) => ({
	_type: "image",
	_key: "img",
	asset: { _ref: "01REF", url },
	alt: "Photo",
	width: 1200,
	height: 800,
});

const imgSrc = (html: string) =>
	/<img\b[^>]*\ssrc="([^"]*)"/.exec(html)?.[1]?.replaceAll("&amp;", "&");

async function render(component: unknown, props: Record<string, unknown>) {
	const container = await AstroContainer.create();
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Astro component import
	return container.renderToString(component as Parameters<typeof container.renderToString>[0], {
		props,
		locals,
		request: new Request("https://site.example/post"),
	});
}

beforeEach(() => vi.mocked(getImage).mockClear());

describe("media from another EmDash site", () => {
	test("Image renders it unoptimized", async () => {
		const html = await render(Image, { node: ptImage(OTHER_SITE) });

		expect(imgSrc(html)).toBe(OTHER_SITE);
		expect(getImage).not.toHaveBeenCalledWith(expect.objectContaining({ src: OTHER_SITE }));
	});

	test("Gallery renders it unoptimized", async () => {
		const html = await render(Gallery, {
			node: { _type: "gallery", _key: "g", images: [ptImage(OTHER_SITE)] },
		});

		expect(imgSrc(html)).toBe(OTHER_SITE);
		expect(getImage).not.toHaveBeenCalledWith(expect.objectContaining({ src: OTHER_SITE }));
	});

	test("EmDashImage renders it unoptimized", async () => {
		const html = await render(EmDashImage, {
			image: { id: "01OTHER", src: OTHER_SITE, alt: "Photo", width: 1200, height: 800 },
		});

		expect(imgSrc(html)).toBe(OTHER_SITE);
		expect(getImage).not.toHaveBeenCalledWith(expect.objectContaining({ src: OTHER_SITE }));
	});

	test("this site's media is still optimized", async () => {
		await render(Image, { node: ptImage(OWN_MEDIA) });

		expect(getImage).toHaveBeenCalledWith(
			expect.objectContaining({ src: `https://site.example${OWN_MEDIA}` }),
		);
	});
});
