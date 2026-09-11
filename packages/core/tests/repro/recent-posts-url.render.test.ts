import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it, vi } from "vitest";

import RecentPosts from "../../src/components/widgets/RecentPosts.astro";

vi.mock("../../src/query.js", () => ({
	getEmDashCollection: vi.fn(async () => ({
		entries: [
			{
				// The loader's entry id is the slug, or `locale/slug` with
				// i18n prefixing — distinct from the content ULID in data.id.
				id: "en/hello-world",
				data: {
					id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
					slug: "hello-world",
					title: "Hello World",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		],
	})),
}));

async function renderHref(props: Record<string, unknown>): Promise<string> {
	const container = await AstroContainer.create();
	const html = await container.renderToString(RecentPosts, { props, locals: {} });
	const match = html.match(/<a href="([^"]*)"/);
	if (!match) throw new Error(`no link in rendered widget: ${html}`);
	return match[1]!;
}

describe("RecentPosts link URLs", () => {
	it("keeps the locale-prefixed default without a template", async () => {
		expect(await renderHref({})).toBe("/posts/en/hello-world");
	});

	it("substitutes the bare slug into :slug", async () => {
		expect(await renderHref({ urlTemplate: "/blog/:slug" })).toBe("/blog/hello-world");
	});

	it("substitutes the content ULID into :id, not the slug-shaped entry id", async () => {
		expect(await renderHref({ urlTemplate: "/posts/:id" })).toBe(
			"/posts/01ARZ3NDEKTSV4RRFFQ69G5FAV",
		);
	});
});
