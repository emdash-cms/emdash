import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, test } from "vitest";

import EmDashImage from "../../src/components/EmDashImage.astro";

const locals = {
	emdash: { getPublicMediaUrl: (k: string) => `/_emdash/api/media/file/${k}` },
};

const light = {
	id: "01LIGHT",
	src: "https://cdn.example.com/light.png",
	alt: "Architecture diagram",
	width: 800,
	height: 400,
	dominantColor: "#ffffff",
};
const dark = {
	id: "01DARK",
	src: "https://cdn.example.com/dark.png",
	alt: "Architecture diagram on black",
	width: 800,
	height: 400,
	dominantColor: "#000000",
};

const imgTags = (html: string) => html.match(/<img\b[^>]*>/g) ?? [];
const attr = (tag: string, name: string) =>
	tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]?.replaceAll("&amp;", "&");

async function render(props: Record<string, unknown>) {
	const c = await AstroContainer.create();
	return c.renderToString(EmDashImage, { props, locals });
}

describe("EmDashImage dark variant", () => {
	test("an image without a variant renders a single <img> without variant classes", async () => {
		const html = await render({ image: light });
		const tags = imgTags(html);

		expect(tags).toHaveLength(1);
		expect(attr(tags[0]!, "class")).not.toContain("emdash-image--");
	});

	test("a stored darkVariant renders a second <img> marked for the dark scheme", async () => {
		const html = await render({ image: { ...light, darkVariant: dark } });
		const [lightTag, darkTag] = imgTags(html);

		expect(imgTags(html)).toHaveLength(2);
		expect(attr(lightTag!, "src")).toBe(light.src);
		expect(attr(lightTag!, "class")).toContain("emdash-image--light");
		expect(attr(darkTag!, "src")).toBe(dark.src);
		expect(attr(darkTag!, "class")).toContain("emdash-image--dark");
	});

	test("both variants carry the primary image's alt text", async () => {
		const html = await render({ image: { ...light, darkVariant: dark } });
		const [lightTag, darkTag] = imgTags(html);

		expect(attr(lightTag!, "alt")).toBe("Architecture diagram");
		expect(attr(darkTag!, "alt")).toBe("Architecture diagram");
	});

	test("an alt override applies to both variants", async () => {
		const html = await render({ image: { ...light, darkVariant: dark }, alt: "Overview" });

		for (const tag of imgTags(html)) {
			expect(attr(tag, "alt")).toBe("Overview");
		}
	});

	test("each variant keeps its own LQIP placeholder", async () => {
		const html = await render({ image: { ...light, darkVariant: dark } });
		const [lightTag, darkTag] = imgTags(html);

		expect(attr(lightTag!, "style")).toContain("#ffffff");
		expect(attr(darkTag!, "style")).toContain("#000000");
	});

	test("both variants are lazy by default", async () => {
		const html = await render({ image: { ...light, darkVariant: dark } });

		for (const tag of imgTags(html)) {
			expect(attr(tag, "loading")).toBe("lazy");
			expect(tag).not.toContain("fetchpriority=");
		}
	});

	test("priority applies eager loading and high fetch priority to both variants", async () => {
		const html = await render({ image: { ...light, darkVariant: dark }, priority: true });

		for (const tag of imgTags(html)) {
			expect(attr(tag, "loading")).toBe("eager");
			expect(attr(tag, "fetchpriority")).toBe("high");
		}
	});

	test("the darkVariant prop overrides a stored variant", async () => {
		const override = { ...dark, src: "https://cdn.example.com/override.png" };
		const html = await render({ image: { ...light, darkVariant: dark }, darkVariant: override });
		const [, darkTag] = imgTags(html);

		expect(attr(darkTag!, "src")).toBe(override.src);
	});

	test("an id is not duplicated across the two variants", async () => {
		const html = await render({ image: { ...light, darkVariant: dark }, id: "hero" });
		const [lightTag, darkTag] = imgTags(html);

		expect(attr(lightTag!, "id")).toBe("hero");
		expect(attr(darkTag!, "id")).toBe("hero--dark");
	});

	test("an image without a variant keeps the id unchanged", async () => {
		const html = await render({ image: light, id: "hero" });

		expect(attr(imgTags(html)[0]!, "id")).toBe("hero");
	});

	test("a string darkVariant is accepted like a string image", async () => {
		const html = await render({ image: light, darkVariant: "https://cdn.example.com/dark.png" });
		const [, darkTag] = imgTags(html);

		expect(imgTags(html)).toHaveLength(2);
		expect(attr(darkTag!, "src")).toBe("https://cdn.example.com/dark.png");
		expect(attr(darkTag!, "class")).toContain("emdash-image--dark");
	});

	test("same-origin local media renders both variants through the Astro image pipeline", async () => {
		const html = await render({
			image: {
				id: "01LOCALLIGHT",
				src: "/_emdash/api/media/file/01LOCALLIGHT.png",
				width: 640,
				height: 320,
				darkVariant: {
					id: "01LOCALDARK",
					src: "/_emdash/api/media/file/01LOCALDARK.png",
					width: 640,
					height: 320,
				},
			},
		});
		const [lightTag, darkTag] = imgTags(html);

		expect(imgTags(html)).toHaveLength(2);
		expect(attr(lightTag!, "data-astro-image")).toBe("constrained");
		expect(attr(lightTag!, "class")).toContain("emdash-image--light");
		expect(attr(darkTag!, "data-astro-image")).toBe("constrained");
		expect(attr(darkTag!, "src")).toContain("01LOCALDARK.png");
		expect(attr(darkTag!, "class")).toContain("emdash-image--dark");
	});
});
