import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import Embed from "../../src/components/Embed.astro";

async function render(url: string, fields: Record<string, string> = {}): Promise<string> {
	const container = await AstroContainer.create();
	return container.renderToString(Embed, {
		props: { node: { _type: "embed", _key: "embed1", url, ...fields } },
	});
}

function attribute(html: string, tag: string, name: string): string | undefined {
	return html
		.match(new RegExp(`<${tag}\\b[^>]*\\s${name}="([^"]*)"`))?.[1]
		?.replaceAll("&amp;", "&");
}

describe("Embed video detection", () => {
	it.each([
		"https://example.com/share?u=https://youtu.be/dQw4w9WgXcQ",
		"https://notyoutube.com/embed/dQw4w9WgXcQ",
		"https://notvimeo.com/123",
		"https://example.com/?ref=vimeo.com/456",
		"https://youtube.com.example.com/watch?v=dQw4w9WgXcQ",
		"https://vimeo.com.example.com/123",
		"https://youtube.com@example.com/embed/dQw4w9WgXcQ",
		"https://example.com/youtu.be/dQw4w9WgXcQ",
		"/share?u=https://youtu.be/dQw4w9WgXcQ",
		"https://www.youtube.com/redirect?u=https://youtu.be/dQw4w9WgXcQ",
		"https://vimeo.com/search?ref=vimeo.com/456",
		"https://youtu.be/dQw4w9WgXcQextra",
		"https://youtube.com/watch?v=short",
		"https://youtube.com/embed/dQw4w9WgXcQextra",
		"https://vimeo.com/not-a-video",
		"mailto:editor@youtube.com/embed/dQw4w9WgXcQ",
	])("keeps a non-video URL as a link: %s", async (url) => {
		const html = await render(url);
		expect(html).not.toContain("<iframe");
		expect(attribute(html, "a", "href")).toBe(url);
	});

	it.each([
		["https://youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/embed/dQw4w9WgXcQ"],
		["https://www.youtube.com/embed/dQw4w9WgXcQ", "https://www.youtube.com/embed/dQw4w9WgXcQ"],
		["https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=5", "https://www.youtube.com/embed/dQw4w9WgXcQ"],
		["http://youtu.be/dQw4w9WgXcQ?si=share", "https://www.youtube.com/embed/dQw4w9WgXcQ"],
		["https://vimeo.com/123", "https://player.vimeo.com/video/123"],
		["https://www.vimeo.com/456?share=copy", "https://player.vimeo.com/video/456"],
		["https://vimeo.com/123/private-hash", "https://player.vimeo.com/video/123"],
		["https://youtu.be/dQw4w9WgXcQ/", "https://www.youtube.com/embed/dQw4w9WgXcQ"],
		[
			"https://www.youtube.com/embed/dQw4w9WgXcQ/?start=5",
			"https://www.youtube.com/embed/dQw4w9WgXcQ",
		],
		[
			"https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ",
			"https://www.youtube.com/embed/dQw4w9WgXcQ",
		],
		["https://WWW.YouTube.COM/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/embed/dQw4w9WgXcQ"],
	])("renders a provider URL as a player: %s", async (url, src) => {
		expect(attribute(await render(url), "iframe", "src")).toBe(src);
	});

	it("preserves explicit media providers and HTML fallback", async () => {
		const url = "https://example.com/share?u=https://youtu.be/dQw4w9WgXcQ";
		for (const provider of ["video", "audio"]) {
			const html = await render(url, { provider });
			expect(html).toContain(`<${provider}`);
			expect(attribute(html, "source", "src")).toBe(url);
		}
		const html = await render(url, { html: "<p>Embed fallback</p>" });
		expect(html).not.toContain("<iframe");
		expect(html).toContain("<p>Embed fallback</p>");
	});

	it.each(["javascript:alert(1)", "https://", "//youtu.be/dQw4w9WgXcQ"])(
		"safely handles invalid or disallowed URLs: %s",
		async (url) => {
			const html = await render(url);
			expect(html).not.toContain("<iframe");
			expect(attribute(html, "a", "href")).toBe("#");
		},
	);
});
