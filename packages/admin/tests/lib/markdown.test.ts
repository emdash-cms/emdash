import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../../src/lib/markdown";

describe("renderMarkdown", () => {
	it("renders standard markdown", () => {
		const html = renderMarkdown("# Title\n\n**bold** and *italic*");
		expect(html).toContain("<h1>Title</h1>");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<em>italic</em>");
	});

	it("strips a <script> tag", () => {
		const html = renderMarkdown("ok\n\n<script>alert(1)</script>");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("alert(1)");
	});

	it("drops raw HTML blocks, including event-handler attributes", () => {
		const html = renderMarkdown('<div onclick="steal()">hi</div>');
		expect(html).not.toContain("<div");
		expect(html).not.toContain("onclick");
	});

	it("drops images entirely so nothing loads from a foreign host", () => {
		const html = renderMarkdown("![alt text](https://evil.example/tracker.png)");
		expect(html).not.toContain("<img");
		expect(html).not.toContain("evil.example");
		expect(html).toContain("alt text");
	});

	it("renders an https link with target=_blank and rel=noopener noreferrer", () => {
		const html = renderMarkdown("[ok](https://example.com)");
		expect(html).toContain('href="https://example.com"');
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).toContain('target="_blank"');
	});

	it("renders inline markdown inside link text", () => {
		const html = renderMarkdown("[**bold** link](https://example.com)");
		expect(html).toContain('href="https://example.com"');
		expect(html).toContain("<strong>bold</strong>");
		expect(html).not.toContain("**bold**");
	});

	it("drops a javascript: link, keeping only its text", () => {
		const html = renderMarkdown("[click](javascript:alert(1))");
		expect(html).not.toContain("javascript:");
		expect(html).not.toContain("<a");
		expect(html).toContain("click");
	});

	it("drops a data: link", () => {
		const html = renderMarkdown("[x](data:text/html,<script>alert(1)</script>)");
		expect(html).not.toContain("data:");
		expect(html).not.toContain("<script");
	});

	it("never emits an inline style attribute", () => {
		const html = renderMarkdown('<p style="position:fixed;inset:0">x</p>');
		expect(html).not.toContain("style=");
	});
});
