import { describe, expect, it } from "vitest";

import { buildBlogPostingJsonLd, buildWebSiteJsonLd } from "../../../src/page/jsonld.js";
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

	describe("defaultOgImage fallback", () => {
		const defaultOg = "https://example.com/site-default-og.png";

		it("emits og:image and twitter:image from defaultOgImage when page has none", () => {
			const page = createPage({ image: null });

			const contributions = generateBaseSeoContributions(page, defaultOg);

			expect(contributions).toContainEqual({
				kind: "property",
				property: "og:image",
				content: defaultOg,
			});
			expect(contributions).toContainEqual({
				kind: "meta",
				name: "twitter:image",
				content: defaultOg,
			});
			// Card upgrades to summary_large_image once an image is present.
			expect(contributions).toContainEqual({
				kind: "meta",
				name: "twitter:card",
				content: "summary_large_image",
			});
		});

		it("prefers page.image over the site default", () => {
			const page = createPage({ image: "https://example.com/post-hero.png" });

			const contributions = generateBaseSeoContributions(page, defaultOg);

			expect(contributions).toContainEqual({
				kind: "property",
				property: "og:image",
				content: "https://example.com/post-hero.png",
			});
			// Site default should NOT appear when the page has its own image.
			expect(
				contributions.some(
					(c) => c.kind === "property" && c.property === "og:image" && c.content === defaultOg,
				),
			).toBe(false);
		});

		it("prefers seo.ogImage over both page.image and the site default", () => {
			const page = createPage({
				image: "https://example.com/post-hero.png",
				seo: { ogImage: "https://example.com/explicit-og.png" },
			});

			const contributions = generateBaseSeoContributions(page, defaultOg);

			expect(contributions).toContainEqual({
				kind: "property",
				property: "og:image",
				content: "https://example.com/explicit-og.png",
			});
		});

		it("emits no og:image when neither page image nor defaultOgImage are set", () => {
			const page = createPage({ image: null });

			const contributions = generateBaseSeoContributions(page);

			expect(contributions.some((c) => c.kind === "property" && c.property === "og:image")).toBe(
				false,
			);
			// Card stays at summary when no image.
			expect(contributions).toContainEqual({
				kind: "meta",
				name: "twitter:card",
				content: "summary",
			});
		});

		it("propagates defaultOgImage into BlogPosting JSON-LD image", () => {
			const page = createPage({
				image: null,
				articleMeta: { publishedTime: "2026-04-03T12:00:00.000Z" },
			});

			const graph = buildBlogPostingJsonLd(page, defaultOg);

			expect(graph).toMatchObject({ image: defaultOg });
		});

		it("BlogPosting JSON-LD prefers explicit page image over the default", () => {
			const page = createPage({
				image: "https://example.com/post-hero.png",
				articleMeta: { publishedTime: "2026-04-03T12:00:00.000Z" },
			});

			const graph = buildBlogPostingJsonLd(page, defaultOg);

			expect(graph).toMatchObject({ image: "https://example.com/post-hero.png" });
		});
	});

	describe("node identity", () => {
		// Without an `@id` a node is anonymous: nothing can reference it, and a
		// richer description of the same thing published alongside it stays a
		// separate entity rather than merging into one.
		it("gives the article an @id distinct from the WebPage it is on", () => {
			const graph = buildBlogPostingJsonLd(createPage());
			expect(graph).not.toBeNull();

			// Not the bare canonical: `mainEntityOfPage` already claims that for
			// the WebPage, and reusing it would merge the article with the page.
			expect(graph).toMatchObject({ "@id": "https://example.com/posts/hello#article" });
			const mainEntity = graph?.mainEntityOfPage as Record<string, unknown>;
			expect(graph?.["@id"]).not.toBe(mainEntity["@id"]);
		});

		it("identifies the publisher, so a fuller Organization graph merges with it", () => {
			const graph = buildBlogPostingJsonLd(createPage({ siteUrl: "https://example.com" }));

			// The trailing slash before the fragment is load-bearing:
			// `https://example.com#organization` is a different IRI, and a
			// mismatch publishes two organisations instead of one.
			expect(graph?.publisher).toEqual({
				"@type": "Organization",
				"@id": "https://example.com/#organization",
				name: "My Site",
			});
		});

		it("keeps the publisher self-sufficient when nothing else describes it", () => {
			const publisher = buildBlogPostingJsonLd(createPage())?.publisher as Record<string, unknown>;

			// A bare `{ "@id": … }` would be a dangling reference on a site with
			// no Organization graph — worse than the anonymous node it replaces.
			expect(publisher["@type"]).toBe("Organization");
			expect(publisher.name).toBe("My Site");
		});

		it("gives the WebSite an @id so a plugin can extend it", () => {
			const graph = buildWebSiteJsonLd(createPage({ pageType: "website" }));

			expect(graph).toMatchObject({ "@id": "https://example.com#website" });
		});
	});
});
