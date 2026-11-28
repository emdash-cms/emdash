import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, test, vi } from "vitest";

import BlogCloudflarePage from "../../../../templates/blog-cloudflare/src/pages/pages/[slug].astro";
import BlogCloudflarePost from "../../../../templates/blog-cloudflare/src/pages/posts/[slug].astro";
import BlogPage from "../../../../templates/blog/src/pages/pages/[slug].astro";
import BlogPost from "../../../../templates/blog/src/pages/posts/[slug].astro";
import MarketingCloudflarePage from "../../../../templates/marketing-cloudflare/src/pages/[slug].astro";
import MarketingCloudflareHome from "../../../../templates/marketing-cloudflare/src/pages/index.astro";
import MarketingPage from "../../../../templates/marketing/src/pages/[slug].astro";
import MarketingHome from "../../../../templates/marketing/src/pages/index.astro";
import PortfolioCloudflarePage from "../../../../templates/portfolio-cloudflare/src/pages/[slug].astro";
import PortfolioCloudflareHome from "../../../../templates/portfolio-cloudflare/src/pages/index.astro";
import PortfolioCloudflareWork from "../../../../templates/portfolio-cloudflare/src/pages/work/[slug].astro";
import PortfolioPage from "../../../../templates/portfolio/src/pages/[slug].astro";
import PortfolioHome from "../../../../templates/portfolio/src/pages/index.astro";
import PortfolioWork from "../../../../templates/portfolio/src/pages/work/[slug].astro";
import StarterCloudflarePage from "../../../../templates/starter-cloudflare/src/pages/[slug].astro";
import StarterCloudflarePost from "../../../../templates/starter-cloudflare/src/pages/posts/[slug].astro";
import StarterPage from "../../../../templates/starter/src/pages/[slug].astro";
import StarterPost from "../../../../templates/starter/src/pages/posts/[slug].astro";
import NotFound from "./fixtures/NotFound.astro";

const dbError = new Error("D1_ERROR: D1 DB is overloaded.");
let entryError: Error | undefined;

vi.mock("emdash", async (importOriginal) => ({
	...(await importOriginal<typeof import("emdash")>()),
	decodeSlug: (slug: string | undefined) => slug,
	getEmDashEntry: async () => ({ entry: null, error: entryError, cacheHint: {} }),
	getEmDashCollection: async () => ({ entries: [], cacheHint: {} }),
	getSiteSettings: async () => ({}),
}));

describe.each([
	["blog post", BlogPost],
	["blog page", BlogPage],
	["blog-cloudflare post", BlogCloudflarePost],
	["blog-cloudflare page", BlogCloudflarePage],
	["starter post", StarterPost],
	["starter page", StarterPage],
	["starter-cloudflare post", StarterCloudflarePost],
	["starter-cloudflare page", StarterCloudflarePage],
	["marketing home", MarketingHome],
	["marketing page", MarketingPage],
	["marketing-cloudflare home", MarketingCloudflareHome],
	["marketing-cloudflare page", MarketingCloudflarePage],
	["portfolio home", PortfolioHome],
	["portfolio page", PortfolioPage],
	["portfolio work", PortfolioWork],
	["portfolio-cloudflare home", PortfolioCloudflareHome],
	["portfolio-cloudflare page", PortfolioCloudflarePage],
	["portfolio-cloudflare work", PortfolioCloudflareWork],
] as const)("%s when the entry query fails", (_name, page) => {
	test("raises the query error instead of answering with a response", async () => {
		entryError = dbError;
		const container = await AstroContainer.create();
		await expect(
			container.renderToResponse(page, { params: { slug: "hello-world" } }),
		).rejects.toBe(dbError);
	});
});

describe.each([
	["blog post", BlogPost],
	["portfolio work", PortfolioWork],
	["starter page", StarterPage],
] as const)("%s when the entry is missing", (_name, page) => {
	test("answers with a 404", async () => {
		entryError = undefined;
		const container = await AstroContainer.create();
		container.insertPageRoute("/404", NotFound);
		const response = await container.renderToResponse(page, { params: { slug: "missing" } });
		expect(response.status).toBe(404);
	});
});
