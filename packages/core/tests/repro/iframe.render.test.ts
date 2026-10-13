import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import PortableText from "../../src/components/PortableText.astro";

async function render(block: Record<string, unknown>): Promise<string> {
	const container = await AstroContainer.create();
	return container.renderToString(PortableText, {
		props: { value: [{ _type: "iframe", _key: "frame1", ...block }] },
		request: new Request("https://site.example/posts/hello"),
	});
}

function attribute(html: string, tag: string, name: string): string | undefined {
	const element = html.match(new RegExp(`<${tag}\\b(?:[^>"]|"[^"]*")*>`))?.[0];
	return element
		?.match(new RegExp(`\\s${name}(?:="([^"]*)")?(?=[\\s>/])`))?.[1]
		?.replaceAll("&quot;", '"')
		.replaceAll("&amp;", "&");
}

describe("Iframe rendering", () => {
	it("renders a cross-origin page in a lazy, sandboxed iframe", async () => {
		const html = await render({
			src: "https://www.youtube.com/embed/abc",
			title: "Launch video",
			allow: "autoplay; camera; encrypted-media",
			allowFullscreen: true,
		});

		expect(attribute(html, "iframe", "src")).toBe("https://www.youtube.com/embed/abc");
		expect(attribute(html, "iframe", "title")).toBe("Launch video");
		expect(attribute(html, "iframe", "loading")).toBe("lazy");
		expect(attribute(html, "iframe", "referrerpolicy")).toBe("strict-origin-when-cross-origin");
		expect(attribute(html, "iframe", "sandbox")?.split(" ")).toContain("allow-same-origin");
		expect(attribute(html, "iframe", "allow")).toBe("autoplay; encrypted-media");
		expect(html).toMatch(/<iframe\b[^>]*\sallowfullscreen/);
	});

	it("escapes its title and permissions so middleware that edits the page can't reach them", async () => {
		// Middleware such as the editor toolbar inserts HTML by searching the
		// page's text for `</body>`.
		const html = await render({
			src: "https://example.com/",
			title: 'Map </body><img src=x onerror="alert(1)">',
			allow: "autoplay </body>; fullscreen",
		});

		expect(html).not.toContain("</body>");
		expect(attribute(html, "iframe", "sandbox")).toContain("allow-scripts");
		expect(attribute(html, "iframe", "allow")).toBe("autoplay; fullscreen");
	});

	it("drops a permission whose allowlist is 'none'", async () => {
		const html = await render({
			src: "https://example.com/",
			allow: "autoplay 'none'; fullscreen",
		});

		expect(attribute(html, "iframe", "allow")).toBe("fullscreen");
	});

	it("renders nothing for an iframe block with other fields, which belongs to a plugin", async () => {
		expect(await render({ src: "https://example.com/", theme: "dark" })).not.toContain("<iframe");
		expect(await render({ src: "https://example.com/", title: 5 })).not.toContain("<iframe");
	});

	it("drops same-origin access for a page on the site's own host", async () => {
		const html = await render({ src: "https://site.example/embed/widget" });

		const sandbox = attribute(html, "iframe", "sandbox")?.split(" ");
		expect(sandbox).toContain("allow-scripts");
		expect(sandbox).not.toContain("allow-same-origin");
	});

	it("renders nothing for a source that isn't https", async () => {
		for (const src of ["http://example.com/", "javascript:alert(1)", "/relative", ""]) {
			expect(await render({ src })).not.toContain("<iframe");
		}
	});

	it("sizes the frame from its width and height", async () => {
		const html = await render({ src: "https://example.com/", width: 560, height: 315 });

		expect(attribute(html, "div", "style")).toContain("aspect-ratio: 560 / 315");
	});
});
