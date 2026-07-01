import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import EmDashHead from "../../src/components/EmDashHead.astro";
import type { PublicPageContext } from "../../src/plugins/types.js";

describe("EmDashHead", () => {
	it("renders JSON-LD as a structured data script", async () => {
		const container = await AstroContainer.create();
		const page: PublicPageContext = {
			url: "https://example.com/",
			path: "/",
			locale: "en",
			kind: "custom",
			pageType: "website",
			title: "A Blog",
			description: "A test blog",
			canonical: "https://example.com/",
			image: null,
			siteName: "A Blog",
			siteUrl: "https://example.com",
		};

		const html = await container.renderToString(EmDashHead, {
			props: { page },
			locals: {},
		});

		expect(html).toContain('<script type="application/ld+json">');
		expect(html).toContain('"@type":"WebSite"');
		expect(html).toContain('"url":"https://example.com"');
	});
});
