import { PortableText } from "astro-portabletext";
/**
 * Renders a WordPress-migrated image node through astro-portabletext using
 * the SAME dispatch production uses (type.image -> Image.astro), three ways:
 *   1. default Image.astro directly
 *   2. via a delegating override (a custom component that re-invokes <Image>)
 *   3. with locals.emdash absent (the "component override" context theory)
 * Then we read the emitted <img src> to see if/when it is empty.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, test } from "vitest";

import Image from "../../src/components/Image.astro";
import OverrideImage from "./OverrideImage.astro";

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

describe("faithful render of migrated image node", () => {
	test("default type.image=Image.astro", async () => {
		const c = await AstroContainer.create();
		const html = await c.renderToString(PortableText, {
			props: { value, components: { type: { image: Image } } },
			locals,
		});
		console.log("[default]   src =", imgSrc(html));
		console.log("[default]   html =", html.replace(/\s+/g, " ").trim().slice(0, 400));
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
		console.log("[override]  src =", imgSrc(html));
		console.log("[override]  html =", html.replace(/\s+/g, " ").trim().slice(0, 500));
		expect(imgSrc(html)).not.toBe("(no <img>)");
	});

	test("default render with locals.emdash ABSENT", async () => {
		const c = await AstroContainer.create();
		const html = await c.renderToString(PortableText, {
			props: { value, components: { type: { image: Image } } },
		});
		console.log("[no-locals] src =", imgSrc(html));
		expect(imgSrc(html)).not.toBe("(no <img>)");
	});
});
