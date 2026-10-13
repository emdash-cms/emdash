import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/query.js", () => ({ getEmDashCollection: vi.fn() }));
vi.mock("../../src/settings/index.js", () => ({ getSiteSettings: vi.fn() }));

import RecentPosts from "../../src/components/widgets/RecentPosts.astro";
import { setI18nConfig } from "../../src/i18n/config.js";
import { getEmDashCollection } from "../../src/query.js";
import { getSiteSettings } from "../../src/settings/index.js";

const locals = {
	emdash: { getPublicMediaUrl: (key: string) => `/_emdash/api/media/file/${key}` },
};

async function render(props: Record<string, unknown> = {}) {
	const container = await AstroContainer.create();
	return container.renderToString(RecentPosts, { props, locals });
}

describe("RecentPosts widget", () => {
	beforeEach(() => {
		vi.mocked(getEmDashCollection).mockResolvedValue({
			entries: [
				{
					id: "late-post",
					data: {
						title: "Late post",
						publishedAt: new Date("2026-10-01T23:22:05.000Z"),
						featured_image: {
							id: "01J8K",
							provider: "local",
							meta: { storageKey: "featured.jpg" },
						},
					},
					edit: {},
				},
			],
			cacheHint: {},
		} as never);
		vi.mocked(getSiteSettings).mockResolvedValue({ timezone: "Australia/Sydney" });
	});

	it("shows the publication date in the site timezone", async () => {
		const html = await render();

		expect(html).toMatch(
			/<time datetime="2026-10-01T23:22:05\.000Z"[^>]*>\s*October 2, 2026\s*<\/time>/,
		);
	});

	it("falls back to UTC when the site timezone is not recognized", async () => {
		vi.mocked(getSiteSettings).mockResolvedValue({ timezone: "Australia/Atlantis" });

		const html = await render();

		expect(html).toMatch(/<time[^>]*>\s*October 1, 2026\s*<\/time>/);
	});

	it("formats the date in the site's default locale", async () => {
		setI18nConfig({ defaultLocale: "fr", locales: ["fr"] });
		try {
			const html = await render();

			expect(html).toMatch(/<time[^>]*>\s*2 octobre 2026\s*<\/time>/);
		} finally {
			setI18nConfig(null);
		}
	});

	it("renders a media-object thumbnail at a fixed size", async () => {
		const html = await render({ showThumbnails: true });
		const img = html.match(/<img\b[^>]*>/)?.[0] ?? "";

		expect(img).toContain("featured.jpg");
		expect(img).toMatch(/\bwidth="96"/);
		expect(img).toMatch(/\bheight="96"/);
	});
});
