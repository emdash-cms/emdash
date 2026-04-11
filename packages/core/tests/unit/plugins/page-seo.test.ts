import { describe, expect, it } from "vitest";

import { buildBlogPostingJsonLd } from "../../../src/page/jsonld.js";
import { generateBaseSeoContributions } from "../../../src/page/seo-contributions.js";
import type { PublicPageContext } from "../../../src/plugins/types.js";

function createPage(overrides: Partial<PublicPageContext> = {}): PublicPageContext {
	return {
		url: "https://example.com/posts/hello",
		path: "/posts/hello",
		locale: null,
		kind: "content",
		pageType: "article",
		title: "Hello World | My Site",
		description: "Test description",
		canonical: "https://example.com/posts/hello",
		image: "https://example.com/og.png",
		siteName: "My Site",
		...overrides,
	};
}

describe("page SEO metadata", () => {
	it("uses pageTitle for og:title and twitter:title", () => {
		const page = createPage({ pageTitle: "Hello World" });

		const contributions = generateBaseSeoContributions(page);

		expect(contributions).toContainEqual({
			kind: "property",
			property: "og:title",
			content: "Hello World",
		});
		expect(contributions).toContainEqual({
			kind: "meta",
			name: "twitter:title",
			content: "Hello World",
		});
	});

	it("prefers explicit seo.ogTitle over pageTitle", () => {
		const page = createPage({
			seo: { ogTitle: "Custom OG Title" },
			pageTitle: "Hello World",
		});

		const contributions = generateBaseSeoContributions(page);

		expect(contributions).toContainEqual({
			kind: "property",
			property: "og:title",
			content: "Custom OG Title",
		});
		expect(contributions).toContainEqual({
			kind: "meta",
			name: "twitter:title",
			content: "Custom OG Title",
		});
	});

	it("falls back to title when pageTitle is absent", () => {
		const page = createPage();

		const contributions = generateBaseSeoContributions(page);

		expect(contributions).toContainEqual({
			kind: "property",
			property: "og:title",
			content: "Hello World | My Site",
		});
	});

	it("uses pageTitle for article JSON-LD headline", () => {
		const page = createPage({
			articleMeta: { publishedTime: "2026-04-03T12:00:00.000Z" },
			pageTitle: "Hello World",
		});

		const graph = buildBlogPostingJsonLd(page);

		expect(graph).toMatchObject({
			headline: "Hello World",
		});
	});
});
