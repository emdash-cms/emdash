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

describe("Embed HTML with an iframe from a host the sanitizer blocks", () => {
	const url = "https://www.google.com/maps/d/embed?mid=abc";
	const html = `<iframe src="${url}" width="840" height="580"></iframe>`;

	it("renders a link to the embed URL instead of an empty frame", async () => {
		const rendered = await render(url, { html, caption: "Site plan" });
		expect(rendered).not.toContain("<iframe");
		expect(attribute(rendered, "a", "href")).toBe(url);
		expect(rendered).toContain("Site plan");
	});

	it("renders a link when sanitizing leaves no content", async () => {
		const rendered = await render(url, { html: "<script>embed()</script>" });
		expect(rendered).not.toContain("emdash-embed-html");
		expect(attribute(rendered, "a", "href")).toBe(url);
	});

	it("keeps the other HTML and adds the link", async () => {
		const rendered = await render(url, { html: `<p>Our office</p>${html}` });
		expect(rendered).toContain("<p>Our office</p>");
		expect(rendered).not.toContain("<iframe");
		expect(attribute(rendered, "a", "href")).toBe(url);
	});

	it.each(["autoplay src=x", "autoplay src="])(
		"is not fooled by src= inside another attribute value: %s",
		async (allow) => {
			const rendered = await render(url, {
				html: `<iframe allow="${allow}" src="${url}"></iframe>`,
			});
			expect(rendered).not.toContain("<iframe");
			expect(attribute(rendered, "a", "href")).toBe(url);
		},
	);

	it("keeps an allowed iframe next to a blocked one", async () => {
		const src = "https://player.vimeo.com/video/123";
		const rendered = await render(url, { html: `<iframe src="${src}"></iframe>${html}` });
		expect(attribute(rendered, "iframe", "src")).toBe(src);
		expect(rendered.match(/<iframe/g)).toHaveLength(1);
		expect(attribute(rendered, "a", "href")).toBe(url);
	});

	it("keeps iframes from allowed hosts without adding a link", async () => {
		const src = "https://player.vimeo.com/video/123";
		const rendered = await render("https://example.com/page", {
			html: `<iframe src="${src}"></iframe>`,
		});
		expect(attribute(rendered, "iframe", "src")).toBe(src);
		expect(rendered).not.toContain("<a ");
	});

	it("renders provider HTML without an iframe without adding a link", async () => {
		const rendered = await render("https://twitter.com/user/status/1", {
			html: `<blockquote class="twitter-tweet"><p>Hello</p></blockquote>`,
		});
		expect(rendered).toContain("<p>Hello</p>");
		expect(rendered).not.toContain('href="https://twitter.com/user/status/1"');
	});
});
