import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it, vi } from "vitest";

vi.mock("astro:config/server", () => ({
	i18n: { defaultLocale: "uk", locales: ["uk", "en"], routing: { prefixDefaultLocale: false } },
}));

// Without an explicit locale these return default-locale rows, as the real
// queries do for anonymous visitors, who get no request-context locale.
vi.mock("../../src/taxonomies/index.js", () => ({
	getTaxonomyTerms: async (taxonomy: string, options: { locale?: string } = {}) => {
		const english = options.locale === "en";
		return taxonomy === "category"
			? [{ slug: english ? "news" : "novyny", label: english ? "News" : "Новини", count: 1 }]
			: [
					{
						slug: english ? "history" : "istoriia",
						label: english ? "History" : "Історія",
						count: 1,
					},
				];
	},
}));
vi.mock("../../src/query.js", () => ({
	getEmDashCollection: async (_collection: string, options: { locale?: string } = {}) => ({
		entries: [
			{
				id: options.locale === "en" ? "en/museum-news" : "novyna",
				data: {
					id:
						options.locale === "en" ? "01JEN0000000000000000000000" : "01JUK0000000000000000000000",
					slug: options.locale === "en" ? "museum-news" : "novyna",
					title: options.locale === "en" ? "Museum news" : "Новина музею",
					publishedAt: new Date("2025-01-15T10:00:00.000Z"),
				},
			},
		],
	}),
	getPublishedDates: async (_collection: string, options: { locale?: string } = {}) => ({
		dates:
			options.locale === "en"
				? ["2025-01-15T10:00:00.000Z", "2025-01-20T10:00:00.000Z"]
				: ["2024-03-10T10:00:00.000Z"],
	}),
}));
vi.mock("../../src/settings/index.js", () => ({ getSiteSettings: async () => ({}) }));

import Archives from "../../src/components/widgets/Archives.astro";
import Categories from "../../src/components/widgets/Categories.astro";
import RecentPosts from "../../src/components/widgets/RecentPosts.astro";
import Tags from "../../src/components/widgets/Tags.astro";

function createContainer() {
	return AstroContainer.create({
		manifest: {
			i18n: {
				strategy: "pathname-prefix-other-locales",
				locales: ["uk", "en"],
				defaultLocale: "uk",
				domainLookupTable: {},
			},
		} as never,
	});
}

async function renderAt(path: string) {
	const container = await createContainer();
	const options = { request: new Request(`http://localhost${path}`), locals: {} };
	return {
		categories: await container.renderToString(Categories, options),
		tags: await container.renderToString(Tags, options),
		recent: await container.renderToString(RecentPosts, options),
		recentWithTemplate: await container.renderToString(RecentPosts, {
			...options,
			props: { urlTemplate: "/blog/:slug" },
		}),
		archives: await container.renderToString(Archives, options),
	};
}

describe("widgets on a translated site", () => {
	it("show a translated page's own terms, posts and archives, linked under its locale", async () => {
		const html = await renderAt("/en/");

		expect(html.categories).toContain('href="/en/category/news"');
		expect(html.categories).toContain("News");
		expect(html.tags).toContain('href="/en/tag/history"');
		expect(html.recent).toContain("Museum news");
		expect(html.recent).toContain('href="/en/posts/museum-news"');
		expect(html.recentWithTemplate).toContain('href="/en/blog/museum-news"');
		expect(html.archives).toContain('href="/en/archives/2025/01"');
		expect(html.archives).toContain("(2)");
	});

	it("keep a post URL template that already names the locale", async () => {
		const container = await createContainer();
		const html = await container.renderToString(RecentPosts, {
			request: new Request("http://localhost/en/"),
			locals: {},
			props: { urlTemplate: "/en/news/:slug" },
		});

		expect(html).toContain('href="/en/news/museum-news"');
	});

	it("link a translated page under the site's base path and then its locale", async () => {
		vi.stubEnv("BASE_URL", "/field-notes/");
		try {
			const html = await renderAt("/en/");

			expect(html.categories).toContain('href="/field-notes/en/category/news"');
			expect(html.tags).toContain('href="/field-notes/en/tag/history"');
			expect(html.recent).toContain('href="/field-notes/en/posts/museum-news"');
			expect(html.archives).toContain('href="/field-notes/en/archives/2025/01"');

			const container = await createContainer();
			const withBaseTemplate = await container.renderToString(RecentPosts, {
				request: new Request("http://localhost/field-notes/en/"),
				locals: {},
				props: { urlTemplate: "/field-notes/blog/:slug" },
			});
			expect(withBaseTemplate).toContain('href="/field-notes/en/blog/museum-news"');
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("keep default-locale pages unprefixed", async () => {
		const html = await renderAt("/");

		expect(html.categories).toContain('href="/category/novyny"');
		expect(html.tags).toContain('href="/tag/istoriia"');
		expect(html.recent).toContain("Новина музею");
		expect(html.recent).toContain('href="/posts/novyna"');
		expect(html.recentWithTemplate).toContain('href="/blog/novyna"');
		expect(html.archives).toContain('href="/archives/2024/03"');
		expect(html.archives).toContain("(1)");
	});
});
