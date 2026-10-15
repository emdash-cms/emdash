import { describe, expect, it } from "vitest";

import { parseCollectionSitemapName } from "../../../src/seo/sitemap-name.js";

describe("parseCollectionSitemapName", () => {
	it("reads the collection and page", () => {
		expect(parseCollectionSitemapName("post")).toEqual({ collection: "post", page: 1 });
		expect(parseCollectionSitemapName("post-2")).toEqual({ collection: "post", page: 2 });
		expect(parseCollectionSitemapName("blog_posts-123456")).toEqual({
			collection: "blog_posts",
			page: 123456,
		});
	});

	it("accepts a collection slug of the maximum length", () => {
		expect(parseCollectionSitemapName("a".repeat(63))).toEqual({
			collection: "a".repeat(63),
			page: 1,
		});
	});

	it.each(["0", "Post", "a.b", "", "post-1", "post-0", "post-02", "post-1234567", "a".repeat(64)])(
		"returns null for %s",
		(name) => {
			expect(parseCollectionSitemapName(name)).toBeNull();
		},
	);
});
