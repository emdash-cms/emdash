import { describe, it, expect } from "vitest";

import { buildBskyPost, buildFacets } from "../src/bluesky.js";

describe("buildFacets", () => {
	it("detects URLs and returns correct byte offsets", () => {
		const text = "Check out https://example.com for more";
		const facets = buildFacets(text);
		expect(facets).toHaveLength(1);

		const facet = facets[0]!;
		expect(facet.features[0]).toEqual({
			$type: "app.bsky.richtext.facet#link",
			uri: "https://example.com",
		});

		// Verify byte offsets match
		const encoder = new TextEncoder();
		const bytes = encoder.encode(text);
		const extracted = new TextDecoder().decode(
			bytes.slice(facet.index.byteStart, facet.index.byteEnd),
		);
		expect(extracted).toBe("https://example.com");
	});

	it("handles multiple URLs", () => {
		const text = "Visit https://a.com and https://b.com today";
		const facets = buildFacets(text);
		expect(facets).toHaveLength(2);
		expect(facets[0]!.features[0]).toHaveProperty("uri", "https://a.com");
		expect(facets[1]!.features[0]).toHaveProperty("uri", "https://b.com");
	});

	it("detects hashtags", () => {
		const text = "Hello #world #atproto";
		const facets = buildFacets(text);
		const tagFacets = facets.filter((f) => f.features[0]?.$type === "app.bsky.richtext.facet#tag");
		expect(tagFacets).toHaveLength(2);
		expect(tagFacets[0]!.features[0]).toHaveProperty("tag", "world");
		expect(tagFacets[1]!.features[0]).toHaveProperty("tag", "atproto");
	});

	it("handles UTF-8 multibyte characters before URLs", () => {
		// Emoji is multiple UTF-8 bytes but one grapheme
		const text = "Great post! 🎉 https://example.com";
		const facets = buildFacets(text);
		expect(facets).toHaveLength(1);

		const encoder = new TextEncoder();
		const bytes = encoder.encode(text);
		const extracted = new TextDecoder().decode(
			bytes.slice(facets[0]!.index.byteStart, facets[0]!.index.byteEnd),
		);
		expect(extracted).toBe("https://example.com");
	});

	it("returns empty array for text with no URLs or hashtags", () => {
		const facets = buildFacets("Just some plain text here");
		expect(facets).toEqual([]);
	});

	it("does not match hashtag at start of word", () => {
		// Hashtag requires preceding whitespace or start of string
		const text = "foo#bar";
		const facets = buildFacets(text);
		const tagFacets = facets.filter((f) => f.features[0]?.$type === "app.bsky.richtext.facet#tag");
		expect(tagFacets).toHaveLength(0);
	});

	it("strips trailing punctuation from URLs", () => {
		const text = "Visit https://example.com/post. More text";
		const facets = buildFacets(text);
		expect(facets).toHaveLength(1);
		expect(facets[0]!.features[0]).toHaveProperty("uri", "https://example.com/post");
	});

	it("strips trailing comma from URL", () => {
		const text = "See https://example.com/a, https://example.com/b";
		const facets = buildFacets(text);
		expect(facets).toHaveLength(2);
		expect(facets[0]!.features[0]).toHaveProperty("uri", "https://example.com/a");
		expect(facets[1]!.features[0]).toHaveProperty("uri", "https://example.com/b");
	});

	it("strips trailing exclamation from URL", () => {
		const text = "Check https://example.com!";
		const facets = buildFacets(text);
		expect(facets[0]!.features[0]).toHaveProperty("uri", "https://example.com");
	});
});

describe("buildBskyPost", () => {
	const baseContent = {
		title: "My Article",
		slug: "my-article",
		excerpt: "A short description",
	};

	it("builds a post with template substitution", () => {
		const post = buildBskyPost({
			template: "{title}\n\n{url}",
			content: baseContent,
			siteUrl: "https://myblog.com",
		});

		expect(post.$type).toBe("app.bsky.feed.post");
		expect(post.text).toBe("My Article\n\nhttps://myblog.com/my-article");
		expect(post.createdAt).toBeDefined();
	});

	it("includes langs when provided", () => {
		const post = buildBskyPost({
			template: "{title}",
			content: baseContent,
			siteUrl: "https://myblog.com",
			langs: ["en", "fr"],
		});
		expect(post.langs).toEqual(["en", "fr"]);
	});

	it("limits langs to 3", () => {
		const post = buildBskyPost({
			template: "{title}",
			content: baseContent,
			siteUrl: "https://myblog.com",
			langs: ["en", "fr", "de", "es"],
		});
		expect(post.langs).toHaveLength(3);
	});

	it("includes link card embed", () => {
		const post = buildBskyPost({
			template: "{title}",
			content: baseContent,
			siteUrl: "https://myblog.com",
		});

		expect(post.embed).toEqual({
			$type: "app.bsky.embed.external",
			external: {
				uri: "https://myblog.com/my-article",
				title: "My Article",
				description: "A short description",
			},
		});
	});

	it("includes thumb in embed when provided", () => {
		const thumb = {
			$type: "blob" as const,
			ref: { $link: "bafkrei123" },
			mimeType: "image/jpeg",
			size: 45000,
		};

		const post = buildBskyPost({
			template: "{title}",
			content: baseContent,
			siteUrl: "https://myblog.com",
			thumbBlob: thumb,
		});

		expect(post.embed?.external.thumb).toBe(thumb);
	});

	it("auto-detects URLs in text for facets", () => {
		const post = buildBskyPost({
			template: "New post: {url}",
			content: baseContent,
			siteUrl: "https://myblog.com",
		});

		expect(post.facets).toBeDefined();
		expect(post.facets!.length).toBeGreaterThan(0);
		expect(post.facets![0]!.features[0]).toHaveProperty("uri", "https://myblog.com/my-article");
	});

	it("substitutes {excerpt} in template", () => {
		const post = buildBskyPost({
			template: "{title}: {excerpt}",
			content: baseContent,
			siteUrl: "https://myblog.com",
		});
		expect(post.text).toBe("My Article: A short description");
	});

	it("strips trailing slash from siteUrl", () => {
		const post = buildBskyPost({
			template: "{url}",
			content: baseContent,
			siteUrl: "https://myblog.com/",
		});
		expect(post.text).toBe("https://myblog.com/my-article");
	});

	it("reads slug from content.data when building URLs", () => {
		const post = buildBskyPost({
			template: "{url}",
			collection: "posts",
			content: {
				title: "Nested Slug",
				data: { slug: "nested-slug" },
			},
			siteUrl: "https://myblog.com",
		});
		expect(post.text).toBe("https://myblog.com/posts/nested-slug");
		expect(post.embed?.external.uri).toBe("https://myblog.com/posts/nested-slug");
	});

	it("skips facets when text is truncated to avoid partial URL links", () => {
		// Create content with very long excerpt that forces truncation
		const longExcerpt = "A".repeat(300);
		const post = buildBskyPost({
			template: "{excerpt} {url}",
			content: { ...baseContent, excerpt: longExcerpt },
			siteUrl: "https://myblog.com",
		});
		// Text was truncated (>300 graphemes), so facets should be omitted
		expect(post.facets).toBeUndefined();
		// But embed should still have the full URL
		expect(post.embed?.external.uri).toBe("https://myblog.com/my-article");
	});
});
