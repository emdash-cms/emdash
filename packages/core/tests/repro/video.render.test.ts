import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import PortableText from "../../src/components/PortableText.astro";

const testMediaProviders = [
	{
		id: "mock-stream",
		name: "Mock Stream",
		capabilities: { browse: false, search: false, upload: false, delete: false },
		createProvider: () => ({
			getEmbed: (value: { id: string }) => ({
				type: "video",
				src: `https://stream.example/${value.id}/video.mp4`,
				sources: [
					{
						src: `https://stream.example/${value.id}/manifest.m3u8`,
						type: "application/x-mpegURL",
					},
				],
				controls: true,
			}),
		}),
	},
	{
		id: "mock-images",
		name: "Mock Images",
		capabilities: { browse: false, search: false, upload: false, delete: false },
		createProvider: () => ({
			getEmbed: () => ({ type: "image", src: "https://img.example/cat.jpg" }),
		}),
	},
	{
		id: "mock-empty",
		name: "Mock Empty",
		capabilities: { browse: false, search: false, upload: false, delete: false },
		createProvider: () => ({
			getEmbed: () => ({ type: "video" }),
		}),
	},
	{
		id: "mock-broken",
		name: "Mock Broken",
		capabilities: { browse: false, search: false, upload: false, delete: false },
		createProvider: () => ({
			getEmbed: () => {
				throw new Error("Provider offline");
			},
		}),
	},
];

(
	globalThis as typeof globalThis & { __emdashTestMediaProviders?: typeof testMediaProviders }
).__emdashTestMediaProviders = testMediaProviders;

async function render(
	block: Record<string, unknown>,
	locals?: { emdash: { getPublicMediaUrl: (key: string) => string } },
): Promise<string> {
	const container = await AstroContainer.create();
	return container.renderToString(PortableText, {
		props: { value: [{ _type: "video", _key: "video1", ...block }] },
		...(locals ? { locals } : {}),
	});
}

function tag(html: string, name: string): string {
	return html.match(new RegExp(`<${name}\\b(?:[^>"]|"[^"]*")*>`))?.[0] ?? "";
}

function attribute(element: string, name: string): string | undefined {
	return element.match(new RegExp(`\\s${name}(?:="([^"]*)")?(?=[\\s>/])`))?.[1];
}

describe("Video rendering", () => {
	it("plays a Media Library video in a native player with its caption", async () => {
		const html = await render({
			asset: { _ref: "01VIDEO", url: "/_emdash/api/media/file/01VIDEO.mp4" },
			caption: "Launch day",
			width: 1920,
			height: 1080,
		});
		const video = tag(html, "video");

		expect(attribute(video, "src")).toBe("/_emdash/api/media/file/01VIDEO.mp4");
		expect(video).toMatch(/\scontrols(?=[\s>])/);
		expect(video).toMatch(/\splaysinline(?=[\s>])/);
		expect(attribute(video, "preload")).toBe("metadata");
		expect(attribute(video, "width")).toBe("1920");
		expect(attribute(video, "height")).toBe("1080");
		expect(html).toMatch(/<figcaption[^>]*>Launch day<\/figcaption>/);
	});

	it("serves a Media Library video from the storage's public URL", async () => {
		const html = await render(
			{ asset: { _ref: "01VIDEO", url: "/_emdash/api/media/file/01VIDEO.mp4" } },
			{ emdash: { getPublicMediaUrl: (key) => `https://media.example/${key}` } },
		);

		expect(attribute(tag(html, "video"), "src")).toBe("https://media.example/01VIDEO.mp4");
		expect(html).not.toContain("<figcaption");
	});

	it("plays a provider's video through the provider, trying every source", async () => {
		const html = await render({ asset: { _ref: "uid42", provider: "mock-stream" } });

		// A `src` on the element would make the browser skip its <source> children.
		expect(attribute(tag(html, "video"), "src")).toBeUndefined();
		expect(
			Array.from(html.matchAll(/<source\b[^>]*\ssrc="([^"]*)"/g), (match) => match[1]),
		).toEqual([
			"https://stream.example/uid42/video.mp4",
			"https://stream.example/uid42/manifest.m3u8",
		]);
	});

	it.each([
		["isn't configured", "missing-provider"],
		["returns an image", "mock-images"],
		["returns a video without a source", "mock-empty"],
		["fails", "mock-broken"],
	])("renders nothing, not even the caption, when the provider %s", async (_, provider) => {
		const html = await render({ asset: { _ref: "uid42", provider }, caption: "Orphan" });

		expect(html).not.toContain("emdash-video");
		expect(html).not.toContain("Orphan");
	});

	it("keeps markup in a video URL inside its attribute", async () => {
		// Middleware such as the editor toolbar inserts HTML by searching the
		// page's text for `</body>`.
		const html = await render({
			asset: { _ref: "01VIDEO", url: '/clips/x</body><img src=x onerror="alert(1)">.mp4' },
		});

		expect(html).not.toContain("</body>");
		expect(html).not.toContain("<img");
		expect(attribute(tag(html, "video"), "src")).toBe(
			"/clips/x%3C/body%3E%3Cimg src=x onerror=&quot;alert(1)&quot;%3E.mp4",
		);
	});

	it("renders nothing for a video block that belongs to a plugin", async () => {
		const html = await render({ asset: { _ref: "01VIDEO" }, autoplay: true });

		expect(html).not.toContain("<video");
		expect(html).not.toContain("emdash-video");
	});

	it.each([
		["a Media Library video saved without its file URL", { asset: { _ref: "01VIDEO" } }],
		["an empty video block", {}],
	])("renders nothing for %s", async (_, fields) => {
		const html = await render({ ...fields, caption: "Missing" });

		expect(html).not.toContain("emdash-video");
		expect(html).not.toContain("Missing");
	});
});
