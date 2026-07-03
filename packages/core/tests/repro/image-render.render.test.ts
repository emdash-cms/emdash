import { PortableText } from "astro-portabletext";
/**
 * Renders WordPress-migrated image nodes through astro-portabletext using
 * the SAME dispatch production uses (type.image -> Image.astro), then pins
 * the local, provider, placeholder, and public Image component edge cases.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, test } from "vitest";

import EmDashImage from "../../src/components/EmDashImage.astro";
import Image from "../../src/components/Image.astro";
import OverrideImage from "./OverrideImage.astro";

const testMediaProviders = [
	{
		id: "mock-images",
		name: "Mock Images",
		capabilities: { list: false, upload: false, delete: false, metadata: false },
		createProvider: () => ({
			id: "mock-images",
			name: "Mock Images",
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

(globalThis as typeof globalThis & { __emdashTestMediaProviders?: typeof testMediaProviders }).__emdashTestMediaProviders =
	testMediaProviders;

const node = {
	_type: "image",
	_key: "img66",
	asset: {
		_ref: "01KTRTJ5QSVC3TB57387DX445P",
		url: "/_emdash/api/media/file/01KTRTJ55S65SADEH9P9TSY89H.png",
	},
	alt: "",
	alignment: "right",
	displayWidth: 136,
	displayHeight: 201,
};
const value = [node];
const locals = {
	emdash: { getPublicMediaUrl: (k: string) => `/_emdash/api/media/file/${k}` },
};

const imgSrc = (html: string) => html.match(/<img[^>]*\bsrc="([^"]*)"/)?.[1] ?? "(no <img>)";
const imgTag = (html: string) => html.match(/<img\b[^>]*>/)?.[0] ?? "";
const attr = (tag: string, name: string) =>
	tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]?.replaceAll("&amp;", "&");
const compact = (html: string) => html.replace(/\s+/g, " ").trim();

async function renderImage(renderNode: Record<string, unknown>, renderLocals: typeof locals | undefined = locals) {
	const c = await AstroContainer.create();
	return c.renderToString(Image, {
		props: { node: renderNode },
		...(renderLocals ? { locals: renderLocals } : {}),
	});
}

async function renderEmDashImage(props: Record<string, unknown>) {
	const c = await AstroContainer.create();
	return c.renderToString(EmDashImage, { props, locals });
}

describe("faithful render of migrated image node", () => {
	test("default type.image=Image.astro", async () => {
		const c = await AstroContainer.create();
		const html = await c.renderToString(PortableText, {
			props: { value, components: { type: { image: Image } } },
			locals,
		});
		expect(imgSrc(html)).not.toBe("(no <img>)");
		// #1404 fix: alignment now rendered as a figure class
		expect(html).toContain("emdash-image--align-right");
	});

	test("delegating override -> emdash <Image>", async () => {
		const c = await AstroContainer.create();
		const html = await c.renderToString(PortableText, {
			props: { value, components: { type: { image: OverrideImage } } },
			locals,
		});
		expect(imgSrc(html)).not.toBe("(no <img>)");
	});

	test("default render with locals.emdash ABSENT", async () => {
		const c = await AstroContainer.create();
		const html = await c.renderToString(PortableText, {
			props: { value, components: { type: { image: Image } } },
		});
		expect(imgSrc(html)).not.toBe("(no <img>)");
	});

	test("local image keeps wrapper, dimensions, alt, caption and alignment", async () => {
		const html = await renderImage({
			...node,
			alt: "Migrated image",
			caption: "A caption",
			alignment: "center",
			width: 1200,
			height: 800,
			displayWidth: 600,
			displayHeight: undefined,
		});
		const tag = imgTag(html);

		expect(compact(html)).toContain("<figure class=\"emdash-image emdash-image--align-center\"");
		expect(attr(tag, "src")).toContain("/_emdash/api/media/file/01KTRTJ55S65SADEH9P9TSY89H.png");
		expect(attr(tag, "alt")).toBe("Migrated image");
		expect(attr(tag, "width")).toBe("600");
		expect(attr(tag, "height")).toBe("400");
		expect(attr(tag, "loading")).toBe("lazy");
		expect(attr(tag, "decoding")).toBe("async");
		expect(html).toContain("<figcaption");
		expect(html).toContain("A caption");
	});

	test("bare local media ref falls back to the media file route", async () => {
		const html = await renderImage({
			...node,
			asset: { _ref: "01LOCALONLY" },
			width: 320,
			height: 180,
			displayWidth: undefined,
			displayHeight: undefined,
		});

		expect(attr(imgTag(html), "src")).toBe("/_emdash/api/media/file/01LOCALONLY");
	});

	test("unknown dimensions still render without forcing Astro to infer remote size", async () => {
		const html = await renderImage({
			...node,
			width: undefined,
			height: undefined,
			displayWidth: undefined,
			displayHeight: undefined,
		});
		const tag = imgTag(html);

		expect(attr(tag, "src")).toContain("/_emdash/api/media/file/01KTRTJ55S65SADEH9P9TSY89H.png");
		expect(tag).not.toContain("srcset=");
		expect(tag).not.toContain("data-astro-image");
	});

	test("LQIP fields survive the image rendering branch", async () => {
		const html = await renderImage({
			...node,
			dominantColor: "rgb(10, 20, 30)",
		});

		expect(attr(imgTag(html), "style")).toContain("background-color: rgb(10, 20, 30)");
	});

	test("legacy LQIP metadata is still used", async () => {
		const html = await renderImage({
			...node,
			asset: {
				...node.asset,
				meta: { dominantColor: "#102030" },
			},
		});

		expect(attr(imgTag(html), "style")).toContain("background-color: #102030");
	});

	test("external providers keep provider-generated responsive URLs", async () => {
		const html = await renderImage({
			...node,
			asset: {
				_ref: "provider-image",
				provider: "mock-images",
			},
			width: 1200,
			height: 800,
			displayWidth: 600,
			displayHeight: undefined,
		});
		const tag = imgTag(html);

		expect(attr(tag, "src")).toBe("https://img.example.com/original?w=600");
		expect(attr(tag, "srcset")).toContain("https://img.example.com/render?w=640&h=427 640w");
		expect(attr(tag, "srcset")).toContain("https://img.example.com/render?w=1080&h=720 1080w");
		expect(attr(tag, "sizes")).toBe("(min-width: 600px) 600px, 100vw");
	});

	test("missing external provider falls back without crashing", async () => {
		const html = await renderImage({
			...node,
			asset: {
				_ref: "missing-provider-image",
				provider: "missing-provider",
			},
		});

		expect(attr(imgTag(html), "src")).toBe("/_emdash/api/media/file/missing-provider-image");
	});

	test("public EmDashImage preserves string URL fallback", async () => {
		const html = await renderEmDashImage({
			image: "https://cdn.example.com/photo.jpg",
			alt: "CDN photo",
			width: 640,
			height: 360,
		});
		const tag = imgTag(html);

		expect(attr(tag, "src")).toBe("https://cdn.example.com/photo.jpg");
		expect(attr(tag, "alt")).toBe("CDN photo");
		expect(attr(tag, "width")).toBe("640");
		expect(attr(tag, "height")).toBe("360");
	});

	test("public EmDashImage preserves priority and passthrough attrs", async () => {
		const html = await renderEmDashImage({
			image: {
				id: "01MEDIA",
				src: "/_emdash/api/media/file/01MEDIA.jpg",
				alt: "Stored media",
				width: 800,
				height: 600,
			},
			priority: true,
			class: "hero-image",
			"data-testid": "hero",
		});
		const tag = imgTag(html);

		expect(attr(tag, "src")).toBe("/_emdash/api/media/file/01MEDIA.jpg");
		expect(attr(tag, "loading")).toBe("eager");
		expect(attr(tag, "fetchpriority")).toBe("high");
		expect(attr(tag, "class")).toBe("hero-image");
		expect(attr(tag, "data-testid")).toBe("hero");
	});
});
