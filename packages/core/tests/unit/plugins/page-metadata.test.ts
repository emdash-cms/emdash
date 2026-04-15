/**
 * Page Metadata Tests
 *
 * Tests the metadata collector for:
 * - Resolving contributions into deduplicated metadata
 * - HTML rendering with proper escaping
 * - Safe JSON-LD serialization
 * - HTML attribute escaping
 */

import { describe, it, expect } from "vitest";

import {
	resolvePageMetadata,
	renderPageMetadata,
	safeJsonLdSerialize,
	escapeHtmlAttr,
} from "../../../src/page/metadata.js";
import type { PageMetadataContribution } from "../../../src/plugins/types.js";

describe("resolvePageMetadata", () => {
	it("resolves meta tags correctly", () => {
		const contributions: PageMetadataContribution[] = [
			{ kind: "meta", name: "description", content: "A test page" },
			{ kind: "meta", name: "robots", content: "index, follow" },
		];

		const result = resolvePageMetadata(contributions);

		expect(result.meta).toEqual([
			{ name: "description", content: "A test page" },
			{ name: "robots", content: "index, follow" },
		]);
	});

	it("resolves property tags correctly", () => {
		const contributions: PageMetadataContribution[] = [
			{ kind: "property", property: "og:title", content: "My Page" },
			{ kind: "property", property: "og:type", content: "article" },
		];

		const result = resolvePageMetadata(contributions);

		expect(result.properties).toEqual([
			{ property: "og:title", content: "My Page" },
			{ property: "og:type", content: "article" },
		]);
	});

	it("resolves canonical link", () => {
		const contributions: PageMetadataContribution[] = [
			{ kind: "link", rel: "canonical", href: "https://example.com/page" },
		];

		const result = resolvePageMetadata(contributions);

		expect(result.links).toEqual([{ rel: "canonical", href: "https://example.com/page" }]);
	});

	it("resolves alternate links with hreflang", () => {
		const contributions: PageMetadataContribution[] = [
			{ kind: "link", rel: "alternate", href: "https://example.com/en/page", hreflang: "en" },
			{ kind: "link", rel: "alternate", href: "https://example.com/fr/page", hreflang: "fr" },
		];

		const result = resolvePageMetadata(contributions);

		expect(result.links).toEqual([
			{ rel: "alternate", href: "https://example.com/en/page", hreflang: "en" },
			{ rel: "alternate", href: "https://example.com/fr/page", hreflang: "fr" },
		]);
	});

	it("resolves nlweb link for agent discovery", () => {
		const contributions: PageMetadataContribution[] = [
			{ kind: "link", rel: "nlweb", href: "https://example.com/nlweb" },
		];

		const result = resolvePageMetadata(contributions);

		expect(result.links).toEqual([{ rel: "nlweb", href: "https://example.com/nlweb" }]);
	});

	it("resolves JSON-LD", () => {
		const graph = { "@type": "Article", name: "Test" };
		const contributions: PageMetadataContribution[] = [{ kind: "jsonld", id: "article", graph }];

		const result = resolvePageMetadata(contributions);

		expect(result.jsonld).toHaveLength(1);
		expect(result.jsonld[0]!.id).toBe("article");
		expect(JSON.parse(result.jsonld[0]!.json)).toEqual(graph);
	});

	it("first-wins dedupe for meta by name", () => {
		const contributions: PageMetadataContribution[] = [
			{ kind: "meta", name: "description", content: "First" },
			{ kind: "meta", name: "description", content: "Second" },
		];

		const result = resolvePageMetadata(contributions);

		expect(result.meta).toHaveLength(1);
		expect(result.meta[0]!.content).toBe("First");
	});

	it("first-wins dedupe for meta by explicit key", () => {
		const contributions: PageMetadataContribution[] = [
			{ kind: "meta", name: "description", content: "First", key: "seo-desc" },
			{ kind: "meta", name: "og-description", content: "Second", key: "seo-desc" },
		];

		const result = resolvePageMetadata(contributions);

		expect(result.meta).toHaveLength(1);
		expect(result.meta[0]!.content).toBe("First");
	});

	it("first-wins dedupe for property", () => {
		const contributions: PageMetadataContribution[] = [
			{ kind: "property", property: "og:title", content: "First" },
			{ kind: "property", property: "og:title", content: "Second" },
		];

		const result = resolvePageMetadata(contributions);

		expect(result.properties).toHaveLength(1);
		expect(result.properties[0]!.content).toBe("First");
	});

	it("canonical is singleton (second canonical ignored)", () => {
		const contributions: PageMetadataContribution[] = [
			{ kind: "link", rel: "canonical", href: "https://example.com/first" },
			{ kind: "link", rel: "canonical", href: "https://example.com/second" },
		];

		const result = resolvePageMetadata(contributions);

		expect(result.links).toHaveLength(1);
		expect(result.links[0]!.href).toBe("https://example.com/first");
	});

	it("alternate links deduped by hreflang", () => {
		const contributions: PageMetadataContribution[] = [
			{ kind: "link", rel: "alternate", href: "https://example.com/en/v1", hreflang: "en" },
			{ kind: "link", rel: "alternate", href: "https://example.com/en/v2", hreflang: "en" },
		];

		const result = resolvePageMetadata(contributions);

		expect(result.links).toHaveLength(1);
		expect(result.links[0]!.href).toBe("https://example.com/en/v1");
	});

	it("JSON-LD deduped by id", () => {
		const contributions: PageMetadataContribution[] = [
			{ kind: "jsonld", id: "article", graph: { "@type": "Article", name: "First" } },
			{ kind: "jsonld", id: "article", graph: { "@type": "Article", name: "Second" } },
		];

		const result = resolvePageMetadata(contributions);

		expect(result.jsonld).toHaveLength(1);
		expect(JSON.parse(result.jsonld[0]!.json)).toEqual({
			"@type": "Article",
			name: "First",
		});
	});

	it("JSON-LD without id is always appended", () => {
		const contributions: PageMetadataContribution[] = [
			{ kind: "jsonld", graph: { "@type": "Article", name: "First" } },
			{ kind: "jsonld", graph: { "@type": "BreadcrumbList", name: "Second" } },
		];

		const result = resolvePageMetadata(contributions);

		expect(result.jsonld).toHaveLength(2);
	});

	it("rejects non-HTTP link href (javascript:, data:, blob:)", () => {
		const contributions: PageMetadataContribution[] = [
			{ kind: "link", rel: "canonical", href: "javascript:alert(1)" },
			{ kind: "link", rel: "alternate", href: "data:text/html,<h1>hi</h1>", hreflang: "en" },
			{ kind: "link", rel: "alternate", href: "blob:https://example.com/abc", hreflang: "fr" },
		];

		const result = resolvePageMetadata(contributions);

		expect(result.links).toHaveLength(0);
	});

	it("accepts valid HTTP and HTTPS hrefs", () => {
		const contributions: PageMetadataContribution[] = [
			{ kind: "link", rel: "canonical", href: "https://example.com/page" },
			{ kind: "link", rel: "alternate", href: "http://example.com/en", hreflang: "en" },
		];

		const result = resolvePageMetadata(contributions);

		expect(result.links).toHaveLength(2);
	});
});

describe("renderPageMetadata", () => {
	it("renders meta tags with escaped attributes", () => {
		const html = renderPageMetadata({
			meta: [{ name: 'desc"ription', content: "A <test> & page" }],
			properties: [],
			links: [],
			jsonld: [],
		});

		expect(html).toBe('<meta name="desc&quot;ription" content="A &lt;test&gt; &amp; page">');
	});

	it("renders property tags", () => {
		const html = renderPageMetadata({
			meta: [],
			properties: [{ property: "og:title", content: "My Page" }],
			links: [],
			jsonld: [],
		});

		expect(html).toBe('<meta property="og:title" content="My Page">');
	});

	it("renders link tags with hreflang", () => {
		const html = renderPageMetadata({
			meta: [],
			properties: [],
			links: [{ rel: "alternate", href: "https://example.com/fr", hreflang: "fr" }],
			jsonld: [],
		});

		expect(html).toBe('<link rel="alternate" href="https://example.com/fr" hreflang="fr">');
	});

	it("renders JSON-LD script tags", () => {
		const json = JSON.stringify({ "@type": "Article" });
		const html = renderPageMetadata({
			meta: [],
			properties: [],
			links: [],
			jsonld: [{ id: "article", json }],
		});

		expect(html).toBe(`<script type="application/ld+json">${json}</script>`);
	});
});

describe("safeJsonLdSerialize", () => {
	it("escapes </script> in nested values", () => {
		const result = safeJsonLdSerialize({ text: "</script><script>alert(1)</script>" });

		expect(result).not.toContain("</script>");
		expect(result).toContain("\\u003c");
		expect(result).toContain("\\u003e");
	});

	it("escapes <!-- sequences", () => {
		const result = safeJsonLdSerialize({ text: "<!-- comment -->" });

		expect(result).not.toContain("<!--");
		expect(result).toContain("\\u003c");
	});

	it("escapes U+2028 line separator", () => {
		const result = safeJsonLdSerialize({ text: "before\u2028after" });

		expect(result).not.toContain("\u2028");
		expect(result).toContain("\\u2028");
	});

	it("escapes U+2029 paragraph separator", () => {
		const result = safeJsonLdSerialize({ text: "before\u2029after" });

		expect(result).not.toContain("\u2029");
		expect(result).toContain("\\u2029");
	});

	it("handles normal objects correctly", () => {
		const obj = { "@type": "Article", name: "Hello World", count: 42 };
		const result = safeJsonLdSerialize(obj);

		// The result should be parseable back to the same object
		// (angle brackets are escaped but that's fine for JSON-LD consumers)
		expect(result).toContain('"@type"');
		expect(result).toContain('"Hello World"');
		expect(result).toContain("42");
	});
});

describe("escapeHtmlAttr", () => {
	it("escapes double quotes", () => {
		expect(escapeHtmlAttr('say "hello"')).toBe("say &quot;hello&quot;");
	});

	it("escapes angle brackets", () => {
		expect(escapeHtmlAttr("<script>")).toBe("&lt;script&gt;");
	});

	it("escapes ampersands", () => {
		expect(escapeHtmlAttr("foo & bar")).toBe("foo &amp; bar");
	});

	it("escapes single quotes", () => {
		expect(escapeHtmlAttr("it's here")).toBe("it&#39;s here");
	});

	it("passes through safe strings unchanged", () => {
		expect(escapeHtmlAttr("hello world")).toBe("hello world");
	});
});
