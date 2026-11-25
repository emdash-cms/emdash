import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterEach, describe, expect, it, vi } from "vitest";

import EmDashHead from "../../src/components/EmDashHead.astro";
import type { PageMetadataContribution, PublicPageContext } from "../../src/plugins/types.js";
import { getSiteSettings } from "../../src/settings/index.js";
import type { SiteSettings } from "../../src/settings/types.js";

const virtualConfig = vi.hoisted((): Record<string, unknown> => ({}));

vi.mock("../../src/settings/index.js", () => ({ getSiteSettings: vi.fn() }));
vi.mock("virtual:emdash/config", () => ({ default: virtualConfig }));

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
		for (const key of Object.keys(virtualConfig)) delete virtualConfig[key];
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

	it.each([
		["without a runtime", undefined],
		["with a runtime", runtimeWithPluginMetadata([])],
	])("names EmDash in a generator tag by default %s", async (_, emdash) => {
		const html = await render({}, emdash);

		expect(html).toContain('<meta name="generator" content="EmDash">');
	});

	it.each([
		["without a runtime", undefined],
		["with a runtime", runtimeWithPluginMetadata([])],
	])("renders no generator tag when the site turns it off %s", async (_, emdash) => {
		virtualConfig.generator = false;

		const html = await render({}, emdash);

		expect(html).not.toContain('name="generator"');
	});

	it("keeps the EmDash generator tag next to a plugin's own", async () => {
		const html = await render(
			{},
			runtimeWithPluginMetadata([{ kind: "meta", name: "generator", content: "Some Plugin" }]),
		);

		expect(html).toContain('<meta name="generator" content="EmDash">');
		expect(html).toContain('<meta name="generator" content="Some Plugin">');
	});
});
