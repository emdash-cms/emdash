import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterEach, describe, expect, it, vi } from "vitest";

import EmDashHead from "../../src/components/EmDashHead.astro";
import type { PageMetadataContribution, PublicPageContext } from "../../src/plugins/types.js";
import { getSiteSettings } from "../../src/settings/index.js";
import type { SiteSettings } from "../../src/settings/types.js";

vi.mock("../../src/settings/index.js", () => ({ getSiteSettings: vi.fn() }));

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

function runtimeWithPluginMetadata(contributions: PageMetadataContribution[]) {
	return {
		collectPageMetadata: async () => contributions,
		collectPageFragments: async () => [],
	};
}

async function render(settings: Partial<SiteSettings>, emdash?: unknown) {
	vi.mocked(getSiteSettings).mockResolvedValue(settings);
	const container = await AstroContainer.create();
	return container.renderToString(EmDashHead, {
		props: { page },
		locals: emdash ? { emdash } : {},
	});
}

describe("EmDashHead", () => {
	afterEach(() => {
		vi.mocked(getSiteSettings).mockReset();
	});

	it("renders JSON-LD as a structured data script", async () => {
		const html = await render({});

		expect(html).toContain('<script type="application/ld+json">');
		expect(html).toContain('"@type":"WebSite"');
		expect(html).toContain('"url":"https://example.com"');
	});

	it("renders a single noindex robots tag over plugin robots metadata while staging", async () => {
		const html = await render(
			{ staging: true },
			runtimeWithPluginMetadata([{ kind: "meta", name: "robots", content: "index, follow" }]),
		);

		expect(html.match(/<meta name="robots"/g)).toHaveLength(1);
		expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
	});

	it("keeps plugin robots metadata once the site is live", async () => {
		const html = await render(
			{ staging: false },
			runtimeWithPluginMetadata([{ kind: "meta", name: "robots", content: "index, follow" }]),
		);

		expect(html).toContain('<meta name="robots" content="index, follow">');
		expect(html).not.toContain("noindex");
	});
});
