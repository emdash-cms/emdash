import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, test, vi } from "vitest";

import CloudflarePostCard from "../../../../templates/blog-cloudflare/src/components/PostCard.astro";
import NodePostCard from "../../../../templates/blog/src/components/PostCard.astro";

const i18n = vi.hoisted(() => ({
	config: null as { defaultLocale: string; locales: string[] } | null,
}));

vi.mock("emdash", () => ({ getI18nConfig: () => i18n.config }));

const post = {
	id: "hello-world",
	data: {
		id: "hello-world",
		title: "Hello World",
		content: [],
		// Local noon, so the calendar date doesn't depend on the test machine's time zone.
		publishedAt: new Date(2026, 9, 7, 12),
	},
	edit: {},
};

async function renderDate(component: typeof NodePostCard): Promise<string | undefined> {
	const container = await AstroContainer.create();
	const html = await container.renderToString(component, { props: { post } });
	return html.match(/<time\b[^>]*>([^<]*)<\/time>/)?.[1]?.trim();
}

describe.each([
	["Node", NodePostCard],
	["Cloudflare", CloudflarePostCard],
] as const)("%s blog post card date", (_name, component) => {
	test("uses US English when i18n isn't configured", async () => {
		i18n.config = null;
		expect(await renderDate(component)).toBe("Oct 7, 2026");
	});

	test("uses the site's default locale", async () => {
		i18n.config = { defaultLocale: "fr", locales: ["fr", "en"] };
		expect(await renderDate(component)).toBe("7 oct. 2026");
	});
});
