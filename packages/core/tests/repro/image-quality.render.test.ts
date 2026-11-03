import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, test } from "vitest";

import EmDashImage from "../../src/components/EmDashImage.astro";
import type { EmbedOptions, ImageEmbed } from "../../src/media/types.js";

const provider = {
	id: "quality-images",
	name: "Quality images",
	capabilities: { list: false, upload: false, delete: false, metadata: false },
	createProvider: () => ({
		getEmbed: (_value: unknown, options: EmbedOptions = {}): ImageEmbed => {
			const getSrc: NonNullable<ImageEmbed["getSrc"]> = (opts) => {
				const url = new URL("https://provider.example.com/photo.jpg");
				if (opts.width) url.searchParams.set("w", String(opts.width));
				if (opts.quality !== undefined) url.searchParams.set("q", String(opts.quality));
				return url.href;
			};
			return { type: "image", src: getSrc(options), getSrc };
		},
	}),
};
(
	globalThis as typeof globalThis & { __emdashTestMediaProviders?: (typeof provider)[] }
).__emdashTestMediaProviders = [provider];

const image = { id: "photo", src: "/_emdash/api/media/file/photo.jpg", width: 800, height: 400 };
const dark = { ...image, id: "dark", src: "/_emdash/api/media/file/dark.jpg" };

async function render(props: Record<string, unknown>) {
	const container = await AstroContainer.create();
	return container.renderToString(EmDashImage, {
		props,
		request: new Request("https://quality.example.com/"),
	});
}

function attr(tag: string, name: string) {
	return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]?.replaceAll("&amp;", "&");
}

function assertQuality(html: string, quality: string, count = 1) {
	const tags = html.match(/<img\b[^>]*>/g) ?? [];
	expect(tags).toHaveLength(count);
	for (const tag of tags) {
		expect(attr(tag, "quality")).toBeUndefined();
		const sources = [
			attr(tag, "src")!,
			...attr(tag, "srcset")!
				.split(", ")
				.map((s) => s.split(" ")[0]!),
		];
		for (const src of sources) {
			expect(new URL(src, "https://example.com").searchParams.get("q")).toBe(quality);
		}
	}
}

describe("EmDashImage quality", () => {
	test.each([70, "high"])(
		"passes quality %s to Astro Image for both color schemes",
		async (quality) => {
			const html = await render({ image: { ...image, darkVariant: dark }, quality });
			assertQuality(html, String(quality), 2);
		},
	);

	test.each([70, "high"])(
		"passes quality %s to responsive getImage for public storage URLs",
		async (quality) => {
			const html = await render({
				image: {
					...image,
					src: "https://quality-storage.example.com/photo.jpg",
					darkVariant: { ...dark, src: "https://quality-storage.example.com/dark.jpg" },
				},
				quality,
			});
			assertQuality(html, String(quality), 2);
		},
	);

	test("passes quality to provider src and each responsive candidate", async () => {
		const html = await render({
			image: { id: "provider-photo", provider: "quality-images", width: 800, height: 400 },
			quality: 70,
		});
		assertQuality(html, "70");
	});

	test.each([
		{ ...image, width: undefined, height: undefined },
		{ ...image, src: "https://unauthorized.example.com/photo.jpg" },
		{ id: "missing", provider: "missing-quality-provider", width: 800, height: 400 },
	])("does not leak quality on unoptimized fallback images ($id)", async (value) => {
		const html = await render({ image: value, quality: 70 });
		const tag = html.match(/<img\b[^>]*>/)?.[0] ?? "";
		expect(tag).toContain("<img");
		expect(attr(tag, "quality")).toBeUndefined();
	});

	test("leaves quality unspecified when omitted", async () => {
		const html = await render({ image });
		const tag = html.match(/<img\b[^>]*>/)?.[0] ?? "";
		expect(tag).toContain("<img");
		expect(attr(tag, "quality")).toBeUndefined();
		expect(new URL(attr(tag, "src")!, "https://example.com").searchParams.has("q")).toBe(false);
	});
});
