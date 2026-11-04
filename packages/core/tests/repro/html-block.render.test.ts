import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import PortableText from "../../src/components/PortableText.astro";

async function render(block: Record<string, unknown>): Promise<string> {
	const container = await AstroContainer.create();
	return container.renderToString(PortableText, {
		props: { value: [{ _type: "htmlBlock", _key: "html001", ...block }] },
	});
}

function attribute(html: string, tag: string, name: string): string | undefined {
	const element = html.match(new RegExp(`<${tag}\\b(?:[^>"]|"[^"]*")*>`))?.[0];
	const value = element?.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
	return value
		?.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}

describe("HtmlBlock rendering", () => {
	it("renders an isolated block in a sandboxed frame without same-origin access", async () => {
		const html = await render({
			html: '<button id="go">Go</button>',
			css: "button { color: red; }",
			js: "document.getElementById('go').addEventListener('click', () => {});",
			isolated: true,
		});

		const sandbox = attribute(html, "iframe", "sandbox")?.split(" ");
		expect(sandbox).toContain("allow-scripts");
		expect(sandbox).not.toContain("allow-same-origin");

		const srcdoc = attribute(html, "iframe", "srcdoc");
		expect(srcdoc).toContain('<button id="go">Go</button>');
		expect(srcdoc).toContain("<style>button { color: red; }</style>");
		expect(srcdoc).toContain(
			"<script>document.getElementById('go').addEventListener('click', () => {});</script>",
		);
	});

	it("escapes the frame document so middleware that edits the page can't reach it", async () => {
		// Middleware such as the editor toolbar inserts HTML by searching the
		// page's text for `</body>`.
		const html = await render({ html: "<p>Hello</p>", js: "console.log(1);", isolated: true });

		expect(html.match(/\ssrcdoc="([^"]*)"/)?.[1]).not.toContain("<");
		expect(html).not.toContain("</body>");
	});

	it("renders nothing for an isolated block with no code", async () => {
		const html = await render({ html: " ", css: "", js: "\n", isolated: true });

		expect(html.trim()).toBe("");
	});

	it("renders a block without the isolated flag inline and sanitized", async () => {
		const html = await render({ html: "<p>Legacy</p><script>alert(1)</script>" });

		expect(html).toContain("<p>Legacy</p>");
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<iframe");
	});
});
