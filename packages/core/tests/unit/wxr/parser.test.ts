/**
 * Unit tests for WXR parser (fast-xml-parser based)
 *
 * Tests the parseWxrString function with various WXR input scenarios
 * to verify compatibility with Cloudflare Workers (workerd) environments
 * where the previous sax dependency (CJS-only) caused "module is not defined" errors.
 */

import { describe, it, expect } from "vitest";

import { parseWxrString, type WxrData } from "../../../src/cli/wxr/parser.js";

/** Minimal valid WXR document */
const MINIMAL_WXR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
	<title>Test Site</title>
	<link>https://example.com</link>
	<description>A test site</description>
	<language>en-US</language>
	<wp:base_site_url>https://example.com</wp:base_site_url>
	<wp:base_blog_url>https://example.com</wp:base_blog_url>
</channel>
</rss>`;

/** WXR with a single published post */
const SINGLE_POST_WXR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
	xmlns:content="http://purl.org/rss/1.0/modules/content/"
	xmlns:dc="http://purl.org/dc/elements/1.1/"
	xmlns:wp="http://wordpress.org/export/1.2/"
>
<channel>
	<title>My Blog</title>
	<link>https://example.com</link>
	<wp:base_site_url>https://example.com</wp:base_site_url>
	<wp:base_blog_url>https://example.com</wp:base_blog_url>

	<wp:author>
		<wp:author_id>1</wp:author_id>
		<wp:author_login><![CDATA[admin]]></wp:author_login>
		<wp:author_email><![CDATA[admin@example.com]]></wp:author_email>
		<wp:author_display_name><![CDATA[Admin User]]></wp:author_display_name>
	</wp:author>

	<item>
		<title>Hello World</title>
		<link>https://example.com/2025/01/hello-world/</link>
		<pubDate>Mon, 15 Jan 2025 10:00:00 +0000</pubDate>
		<dc:creator><![CDATA[admin]]></dc:creator>
		<guid isPermaLink="false">https://example.com/?p=1</guid>
		<content:encoded><![CDATA[<!-- wp:paragraph -->
<p>Welcome to our blog!</p>
<!-- /wp:paragraph -->]]></content:encoded>
		<excerpt:encoded><![CDATA[Welcome!]]></excerpt:encoded>
		<wp:post_id>1</wp:post_id>
		<wp:post_date><![CDATA[2025-01-15 10:00:00]]></wp:post_date>
		<wp:post_date_gmt><![CDATA[2025-01-15 10:00:00]]></wp:post_date_gmt>
		<wp:post_modified><![CDATA[2025-01-15 12:00:00]]></wp:post_modified>
		<wp:post_modified_gmt><![CDATA[2025-01-15 12:00:00]]></wp:post_modified_gmt>
		<wp:post_name><![CDATA[hello-world]]></wp:post_name>
		<wp:status><![CDATA[publish]]></wp:status>
		<wp:post_parent>0</wp:post_parent>
		<wp:menu_order>0</wp:menu_order>
		<wp:post_type><![CDATA[post]]></wp:post_type>
		<wp:is_sticky>0</wp:is_sticky>
		<category domain="category" nicename="tutorials"><![CDATA[Tutorials]]></category>
		<category domain="post_tag" nicename="featured"><![CDATA[Featured]]></category>
		<wp:postmeta>
			<wp:meta_key><![CDATA[_edit_last]]></wp:meta_key>
			<wp:meta_value><![CDATA[1]]></wp:meta_value>
		</wp:postmeta>
		<wp:postmeta>
			<wp:meta_key><![CDATA[custom_field]]></wp:meta_key>
			<wp:meta_value><![CDATA[custom value]]></wp:meta_value>
		</wp:postmeta>
	</item>
</channel>
</rss>`;

/** WXR with categories, tags, and custom taxonomies */
const TAXONOMY_WXR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
	<title>Taxonomy Test</title>
	<link>https://example.com</link>

	<wp:category>
		<wp:term_id>2</wp:term_id>
		<wp:category_nicename>tutorials</wp:category_nicename>
		<wp:category_parent></wp:category_parent>
		<wp:cat_name><![CDATA[Tutorials]]></wp:cat_name>
	</wp:category>

	<wp:category>
		<wp:term_id>3</wp:term_id>
		<wp:category_nicename>news</wp:category_nicename>
		<wp:category_parent>tutorials</wp:category_parent>
		<wp:cat_name><![CDATA[News]]></wp:cat_name>
		<wp:category_description><![CDATA[Latest news]]></wp:category_description>
	</wp:category>

	<wp:tag>
		<wp:term_id>4</wp:term_id>
		<wp:tag_slug>featured</wp:tag_slug>
		<wp:tag_name><![CDATA[Featured]]></wp:tag_name>
	</wp:tag>

	<wp:term>
		<wp:term_id>10</wp:term_id>
		<wp:term_taxonomy>genre</wp:term_taxonomy>
		<wp:term_slug>sci-fi</wp:term_slug>
		<wp:term_name><![CDATA[Science Fiction]]></wp:term_name>
		<wp:term_description><![CDATA[Sci-fi content]]></wp:term_description>
	</wp:term>

	<wp:term>
		<wp:term_id>11</wp:term_id>
		<wp:term_taxonomy>nav_menu</wp:term_taxonomy>
		<wp:term_slug>main-menu</wp:term_slug>
		<wp:term_name><![CDATA[Main Menu]]></wp:term_name>
	</wp:term>
</channel>
</rss>`;

/** WXR with an attachment */
const ATTACHMENT_WXR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
	<title>Attachment Test</title>
	<link>https://example.com</link>

	<item>
		<title>hero-image</title>
		<link>https://example.com/hero-image/</link>
		<wp:post_id>100</wp:post_id>
		<wp:post_name><![CDATA[hero-image]]></wp:post_name>
		<wp:status><![CDATA[inherit]]></wp:status>
		<wp:post_type><![CDATA[attachment]]></wp:post_type>
		<wp:attachment_url><![CDATA[https://example.com/wp-content/uploads/2025/01/hero.jpg]]></wp:attachment_url>
		<wp:postmeta>
			<wp:meta_key><![CDATA[_wp_attached_file]]></wp:meta_key>
			<wp:meta_value><![CDATA[2025/01/hero.jpg]]></wp:meta_value>
		</wp:postmeta>
	</item>
</channel>
</rss>`;

describe("WXR Parser (fast-xml-parser)", () => {
	describe("parseWxrString", () => {
		it("parses minimal WXR with site metadata", async () => {
			const data = await parseWxrString(MINIMAL_WXR);

			expect(data.site.title).toBe("Test Site");
			expect(data.site.link).toBe("https://example.com");
			expect(data.site.description).toBe("A test site");
			expect(data.site.language).toBe("en-US");
			expect(data.site.baseSiteUrl).toBe("https://example.com");
			expect(data.site.baseBlogUrl).toBe("https://example.com");
			expect(data.posts).toEqual([]);
			expect(data.attachments).toEqual([]);
			expect(data.categories).toEqual([]);
			expect(data.tags).toEqual([]);
			expect(data.authors).toEqual([]);
			expect(data.terms).toEqual([]);
			expect(data.navMenus).toEqual([]);
		});

		it("parses a single published post with categories, tags, and meta", async () => {
			const data = await parseWxrString(SINGLE_POST_WXR);

			expect(data.posts.length).toBe(1);
			const post = data.posts[0];

			expect(post.title).toBe("Hello World");
			expect(post.link).toBe("https://example.com/2025/01/hello-world/");
			expect(post.creator).toBe("admin");
			expect(post.id).toBe(1);
			expect(post.postName).toBe("hello-world");
			expect(post.status).toBe("publish");
			expect(post.postType).toBe("post");
			expect(post.content).toContain("wp:paragraph");
			expect(post.excerpt).toBe("Welcome!");
			expect(post.postDate).toBe("2025-01-15 10:00:00");
			expect(post.postDateGmt).toBe("2025-01-15 10:00:00");
			expect(post.isSticky).toBe(false);

			// Categories and tags
			expect(post.categories).toContain("tutorials");
			expect(post.tags).toContain("featured");

			// Post meta
			expect(post.meta.get("_edit_last")).toBe("1");
			expect(post.meta.get("custom_field")).toBe("custom value");
		});

		it("parses categories with hierarchy", async () => {
			const data = await parseWxrString(TAXONOMY_WXR);

			expect(data.categories.length).toBe(2);

			const tutorials = data.categories.find((c) => c.nicename === "tutorials");
			expect(tutorials).toBeDefined();
			expect(tutorials?.id).toBe(2);
			expect(tutorials?.name).toBe("Tutorials");
			expect(tutorials?.parent).toBeUndefined(); // empty parent

			const news = data.categories.find((c) => c.nicename === "news");
			expect(news).toBeDefined();
			expect(news?.id).toBe(3);
			expect(news?.name).toBe("News");
			expect(news?.parent).toBe("tutorials");
			expect(news?.description).toBe("Latest news");
		});

		it("parses tags", async () => {
			const data = await parseWxrString(TAXONOMY_WXR);

			expect(data.tags.length).toBe(1);
			expect(data.tags[0].id).toBe(4);
			expect(data.tags[0].slug).toBe("featured");
			expect(data.tags[0].name).toBe("Featured");
		});

		it("parses generic terms (custom taxonomies and nav_menu)", async () => {
			const data = await parseWxrString(TAXONOMY_WXR);

			expect(data.terms.length).toBe(2);

			const genreTerm = data.terms.find((t) => t.taxonomy === "genre");
			expect(genreTerm).toBeDefined();
			expect(genreTerm?.id).toBe(10);
			expect(genreTerm?.slug).toBe("sci-fi");
			expect(genreTerm?.name).toBe("Science Fiction");
			expect(genreTerm?.description).toBe("Sci-fi content");

			const menuTerm = data.terms.find((t) => t.taxonomy === "nav_menu");
			expect(menuTerm).toBeDefined();
			expect(menuTerm?.id).toBe(11);
			expect(menuTerm?.slug).toBe("main-menu");
		});

		it("parses attachments with URL and meta", async () => {
			const data = await parseWxrString(ATTACHMENT_WXR);

			expect(data.attachments.length).toBe(1);
			const att = data.attachments[0];

			expect(att.id).toBe(100);
			expect(att.title).toBe("hero-image");
			expect(att.url).toBe("https://example.com/wp-content/uploads/2025/01/hero.jpg");
			expect(att.meta.get("_wp_attached_file")).toBe("2025/01/hero.jpg");

			// Attachments should NOT appear in posts
			expect(data.posts.length).toBe(0);
		});

		it("parses authors", async () => {
			const data = await parseWxrString(SINGLE_POST_WXR);

			expect(data.authors.length).toBe(1);
			const author = data.authors[0];
			expect(author.id).toBe(1);
			expect(author.login).toBe("admin");
			expect(author.email).toBe("admin@example.com");
			expect(author.displayName).toBe("Admin User");
		});

		it("handles CDATA content correctly", async () => {
			const data = await parseWxrString(SINGLE_POST_WXR);

			const post = data.posts[0];
			// CDATA content should be preserved as-is
			expect(post.content).toContain("Welcome to our blog!");
			expect(post.postName).toBe("hello-world");
			expect(post.creator).toBe("admin");
		});

		it("handles custom taxonomy assignments on items", async () => {
			const customTaxWxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
	<title>Custom Tax Test</title>
	<link>https://example.com</link>
	<item>
		<title>Test Post</title>
		<wp:post_id>1</wp:post_id>
		<wp:post_type><![CDATA[post]]></wp:post_type>
		<wp:status><![CDATA[publish]]></wp:status>
		<category domain="category" nicename="uncategorized"><![CDATA[Uncategorized]]></category>
		<category domain="genre" nicename="sci-fi"><![CDATA[Science Fiction]]></category>
		<category domain="genre" nicename="fantasy"><![CDATA[Fantasy]]></category>
		<category domain="nav_menu" nicename="main-menu"><![CDATA[Main Menu]]></category>
	</item>
</channel>
</rss>`;

			const data = await parseWxrString(customTaxWxr);

			expect(data.posts.length).toBe(1);
			const post = data.posts[0];

			// Standard categories
			expect(post.categories).toContain("uncategorized");
			expect(post.tags).toEqual([]);

			// Custom taxonomies
			expect(post.customTaxonomies).toBeDefined();
			expect(post.customTaxonomies?.get("genre")).toEqual(["sci-fi", "fantasy"]);
			expect(post.customTaxonomies?.get("nav_menu")).toEqual(["main-menu"]);
		});

		it("handles hierarchical pages with post_parent", async () => {
			const pagesWxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
	<title>Page Test</title>
	<link>https://example.com</link>
	<item>
		<title>Parent Page</title>
		<wp:post_id>10</wp:post_id>
		<wp:post_type><![CDATA[page]]></wp:post_type>
		<wp:status><![CDATA[publish]]></wp:status>
		<wp:post_parent>0</wp:post_parent>
		<wp:menu_order>0</wp:menu_order>
	</item>
	<item>
		<title>Child Page</title>
		<wp:post_id>11</wp:post_id>
		<wp:post_type><![CDATA[page]]></wp:post_type>
		<wp:status><![CDATA[publish]]></wp:status>
		<wp:post_parent>10</wp:post_parent>
		<wp:menu_order>1</wp:menu_order>
	</item>
</channel>
</rss>`;

			const data = await parseWxrString(pagesWxr);

			expect(data.posts.length).toBe(2);
			const parent = data.posts.find((p) => p.id === 10);
			const child = data.posts.find((p) => p.id === 11);

			// 0 means "no parent" in WordPress; stored as 0 in the parsed data,
			// consumers convert to undefined at use time
			expect(parent?.postParent).toBe(0);
			expect(parent?.menuOrder).toBe(0);
			expect(child?.postParent).toBe(10);
			expect(child?.menuOrder).toBe(1);
		});

		it("handles sticky posts", async () => {
			const stickyWxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
	<title>Sticky Test</title>
	<link>https://example.com</link>
	<item>
		<title>Sticky Post</title>
		<wp:post_id>1</wp:post_id>
		<wp:post_type><![CDATA[post]]></wp:post_type>
		<wp:status><![CDATA[publish]]></wp:status>
		<wp:is_sticky>1</wp:is_sticky>
	</item>
	<item>
		<title>Normal Post</title>
		<wp:post_id>2</wp:post_id>
		<wp:post_type><![CDATA[post]]></wp:post_type>
		<wp:status><![CDATA[publish]]></wp:status>
		<wp:is_sticky>0</wp:is_sticky>
	</item>
</channel>
</rss>`;

			const data = await parseWxrString(stickyWxr);

			const stickyPost = data.posts.find((p) => p.id === 1);
			const normalPost = data.posts.find((p) => p.id === 2);

			expect(stickyPost?.isSticky).toBe(true);
			expect(normalPost?.isSticky).toBe(false);
		});

		it("handles password-protected posts", async () => {
			const passwordWxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
	<title>Password Test</title>
	<link>https://example.com</link>
	<item>
		<title>Protected Post</title>
		<wp:post_id>1</wp:post_id>
		<wp:post_type><![CDATA[post]]></wp:post_type>
		<wp:status><![CDATA[publish]]></wp:status>
		<wp:post_password><![CDATA[secret123]]></wp:post_password>
	</item>
</channel>
</rss>`;

			const data = await parseWxrString(passwordWxr);

			expect(data.posts[0].postPassword).toBe("secret123");
		});

		it("handles empty WXR (no items, no taxonomies)", async () => {
			const data = await parseWxrString(MINIMAL_WXR);

			expect(data.site.title).toBe("Test Site");
			expect(data.posts).toEqual([]);
			expect(data.categories).toEqual([]);
			expect(data.attachments).toEqual([]);
		});

		it("handles WXR without RSS wrapper gracefully", async () => {
			const badXml = `<?xml version="1.0"?><html><body>Not WXR</body></html>`;
			const data = await parseWxrString(badXml);

			// Should return empty data, not throw
			expect(data.posts).toEqual([]);
			expect(data.site).toEqual({});
		});

		it("handles single postmeta (not array) by forcing array", async () => {
			const singleMetaWxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
	<title>Single Meta Test</title>
	<link>https://example.com</link>
	<item>
		<title>Post With One Meta</title>
		<wp:post_id>1</wp:post_id>
		<wp:post_type><![CDATA[post]]></wp:post_type>
		<wp:status><![CDATA[publish]]></wp:status>
		<wp:postmeta>
			<wp:meta_key><![CDATA[_edit_last]]></wp:meta_key>
			<wp:meta_value><![CDATA[1]]></wp:meta_value>
		</wp:postmeta>
	</item>
</channel>
</rss>`;

			const data = await parseWxrString(singleMetaWxr);

			expect(data.posts[0].meta.get("_edit_last")).toBe("1");
		});
	});
});
