import { describe, expect, it } from "vitest";

import type { GhostExportData } from "../../../src/import/ghost/parser.js";
import { buildGhostSeedFragment } from "../../../src/import/ghost/to-seed.js";

const ghostData: GhostExportData = {
	posts: [
		{
			id: "post-1",
			title: "Hello",
			slug: "hello",
			html: '<p>Hello <a href="https://masonjames.com/hello/">again</a></p>',
			plaintext: "Hello again",
			feature_image: "__GHOST_URL__/content/images/2024/01/hello.png",
			type: "post",
			status: "published",
			visibility: "members",
			created_at: "2024-01-01T00:00:00.000Z",
			updated_at: "2024-01-02T00:00:00.000Z",
			published_at: "2024-01-03T00:00:00.000Z",
		},
		{
			id: "page-1",
			title: "About",
			slug: "about",
			html: "<p>About page</p>",
			plaintext: "About page",
			type: "page",
			status: "published",
			visibility: "public",
			created_at: "2024-01-01T00:00:00.000Z",
			updated_at: "2024-01-02T00:00:00.000Z",
			published_at: "2024-01-03T00:00:00.000Z",
		},
	],
	tags: [{ id: "tag-1", name: "AI", slug: "ai" }],
	postTags: [{ id: "pt-1", post_id: "post-1", tag_id: "tag-1", sort_order: 0 }],
	users: [],
	postAuthors: [],
	settings: [],
	postsMeta: [{ id: "meta-1", post_id: "post-1", feature_image_alt: "Alt text" }],
	postProducts: [],
};

describe("Ghost to seed", () => {
	it("builds post/page content, tags, and redirects", () => {
		const fragment = buildGhostSeedFragment(ghostData, {
			siteBaseUrl: "https://masonjames.com",
			mediaBaseUrl: "https://media.masonjames.com",
			excludedPageSlugs: ["about"],
			postRoutePrefix: "/blog",
		});

		expect(fragment.taxonomies?.[0]?.name).toBe("tags");
		expect(fragment.taxonomies?.[0]?.terms?.map((term) => term.slug)).toEqual(["ai"]);
		expect(fragment.content.posts).toHaveLength(1);
		expect(fragment.content.pages).toHaveLength(0);
		expect(fragment.redirects).toEqual([
			{
				source: "/hello/",
				destination: "/blog/hello/",
				type: 301,
				enabled: true,
			},
		]);

		const post = fragment.content.posts[0]!;
		expect(post.publishedAt).toBe("2024-01-03T00:00:00.000Z");
		expect(post.taxonomies).toEqual({ tags: ["ai"] });
		expect(post.data.body_html).toContain("/blog/hello/");
		expect(post.data.featured_image_url).toBe(
			"https://media.masonjames.com/content/images/2024/01/hello.png",
		);
		expect(post.data.visibility).toBe("members");
	});
});
