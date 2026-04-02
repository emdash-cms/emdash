import { describe, expect, it } from "vitest";

import {
	buildGhostExcerpt,
	normalizeGhostMediaUrl,
	rewriteGhostHtml,
	stripGhostHtml,
} from "../../../src/import/ghost/rewrite.js";

describe("Ghost rewrite helpers", () => {
	it("rewrites media, post links, and portal links while stripping unsafe tags", () => {
		const input = [
			'<style>.bad{display:none}</style>',
			'<script>alert("nope")</script>',
			'<a href="#/portal/signup">Subscribe</a>',
			'<a href="https://masonjames.com/hello/">Hello</a>',
			'<a href="/hello/">Hello relative</a>',
			'<img src="__GHOST_URL__/content/images/2024/01/hello.png">',
		].join("\n");

		const rewritten = rewriteGhostHtml(input, {
			siteBaseUrl: "https://masonjames.com",
			mediaBaseUrl: "https://media.masonjames.com",
			postSlugs: new Set(["hello"]),
			postRoutePrefix: "/blog",
			subscribePath: "/resources/#subscribe",
		});

		expect(rewritten).not.toContain("<style");
		expect(rewritten).not.toContain("<script");
		expect(rewritten).toContain('href="/resources/#subscribe"');
		expect(rewritten).toContain("/blog/hello/");
		expect(rewritten).toContain("https://media.masonjames.com/content/images/2024/01/hello.png");
	});

	it("builds excerpts and plain text from HTML-first Ghost content", () => {
		const rewrittenHtml = "<p>Hello <strong>world</strong></p>";
		expect(stripGhostHtml(rewrittenHtml)).toBe("Hello world");
		expect(
			buildGhostExcerpt({ title: "Hello", slug: "hello", plaintext: "Hello world" }, rewrittenHtml),
		).toBe("Hello world");
		expect(
			normalizeGhostMediaUrl(
				"__GHOST_URL__/content/images/2024/01/hello.png",
				"https://media.masonjames.com",
			),
		).toBe("https://media.masonjames.com/content/images/2024/01/hello.png");
	});
});
