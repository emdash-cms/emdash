/**
 * Tests for WXR parser
 */

import { Readable } from "node:stream";

import { describe, it, expect } from "vitest";

import { parseWxr } from "../../../src/cli/wxr/parser.js";

function createStream(content: string): Readable {
	return Readable.from([content]);
}

describe("parseWxr", () => {
	it("parses basic WXR structure", async () => {
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <title>Test Site</title>
    <link>https://example.com</link>
    <description>A test WordPress site</description>
    <language>en-US</language>
    <wp:base_site_url>https://example.com</wp:base_site_url>
    <wp:base_blog_url>https://example.com</wp:base_blog_url>
  </channel>
</rss>`;

		const result = await parseWxr(createStream(wxr));

		expect(result.site.title).toBe("Test Site");
		expect(result.site.link).toBe("https://example.com");
		expect(result.site.description).toBe("A test WordPress site");
		expect(result.site.language).toBe("en-US");
	});

	it("parses posts", async () => {
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <title>Test Site</title>
    <item>
      <title>Hello World</title>
      <link>https://example.com/hello-world/</link>
      <pubDate>Mon, 01 Jan 2024 12:00:00 +0000</pubDate>
      <dc:creator>admin</dc:creator>
      <content:encoded><![CDATA[<!-- wp:paragraph -->
<p>Welcome to WordPress!</p>
<!-- /wp:paragraph -->]]></content:encoded>
      <wp:post_id>1</wp:post_id>
      <wp:post_date>2024-01-01 12:00:00</wp:post_date>
      <wp:status>publish</wp:status>
      <wp:post_type>post</wp:post_type>
      <wp:post_name>hello-world</wp:post_name>
    </item>
  </channel>
</rss>`;

		const result = await parseWxr(createStream(wxr));

		expect(result.posts).toHaveLength(1);
		expect(result.posts[0]?.title).toBe("Hello World");
		expect(result.posts[0]?.id).toBe(1);
		expect(result.posts[0]?.status).toBe("publish");
		expect(result.posts[0]?.postType).toBe("post");
		expect(result.posts[0]?.content).toContain("wp:paragraph");
	});

	it("parses pages", async () => {
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>About Us</title>
      <content:encoded><![CDATA[<p>About page content</p>]]></content:encoded>
      <wp:post_id>2</wp:post_id>
      <wp:status>publish</wp:status>
      <wp:post_type>page</wp:post_type>
    </item>
  </channel>
</rss>`;

		const result = await parseWxr(createStream(wxr));

		expect(result.posts).toHaveLength(1);
		expect(result.posts[0]?.title).toBe("About Us");
		expect(result.posts[0]?.postType).toBe("page");
	});

	it("parses attachments", async () => {
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>Test Image</title>
      <wp:post_id>10</wp:post_id>
      <wp:post_type>attachment</wp:post_type>
      <wp:attachment_url>https://example.com/wp-content/uploads/2024/01/test.jpg</wp:attachment_url>
    </item>
  </channel>
</rss>`;

		const result = await parseWxr(createStream(wxr));

		expect(result.posts).toHaveLength(0);
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments[0]?.id).toBe(10);
		expect(result.attachments[0]?.title).toBe("Test Image");
		expect(result.attachments[0]?.url).toContain("test.jpg");
	});

	it("parses categories", async () => {
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <wp:category>
      <wp:term_id>1</wp:term_id>
      <wp:category_nicename>uncategorized</wp:category_nicename>
      <wp:cat_name><![CDATA[Uncategorized]]></wp:cat_name>
    </wp:category>
    <wp:category>
      <wp:term_id>2</wp:term_id>
      <wp:category_nicename>news</wp:category_nicename>
      <wp:cat_name><![CDATA[News]]></wp:cat_name>
      <wp:category_parent>uncategorized</wp:category_parent>
    </wp:category>
  </channel>
</rss>`;

		const result = await parseWxr(createStream(wxr));

		expect(result.categories).toHaveLength(2);
		expect(result.categories[0]?.nicename).toBe("uncategorized");
		expect(result.categories[0]?.name).toBe("Uncategorized");
		expect(result.categories[1]?.parent).toBe("uncategorized");
	});

	it("parses tags", async () => {
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <wp:tag>
      <wp:term_id>5</wp:term_id>
      <wp:tag_slug>javascript</wp:tag_slug>
      <wp:tag_name><![CDATA[JavaScript]]></wp:tag_name>
    </wp:tag>
  </channel>
</rss>`;

		const result = await parseWxr(createStream(wxr));

		expect(result.tags).toHaveLength(1);
		expect(result.tags[0]?.slug).toBe("javascript");
		expect(result.tags[0]?.name).toBe("JavaScript");
	});

	it("parses post categories and tags", async () => {
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>Tagged Post</title>
      <category domain="category" nicename="news"><![CDATA[News]]></category>
      <category domain="post_tag" nicename="javascript"><![CDATA[JavaScript]]></category>
      <category domain="post_tag" nicename="typescript"><![CDATA[TypeScript]]></category>
      <wp:post_type>post</wp:post_type>
    </item>
  </channel>
</rss>`;

		const result = await parseWxr(createStream(wxr));

		expect(result.posts[0]?.categories).toContain("news");
		expect(result.posts[0]?.tags).toContain("javascript");
		expect(result.posts[0]?.tags).toContain("typescript");
	});

	it("parses authors", async () => {
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <wp:author>
      <wp:author_id>1</wp:author_id>
      <wp:author_login>admin</wp:author_login>
      <wp:author_email>admin@example.com</wp:author_email>
      <wp:author_display_name><![CDATA[Administrator]]></wp:author_display_name>
      <wp:author_first_name>Admin</wp:author_first_name>
      <wp:author_last_name>User</wp:author_last_name>
    </wp:author>
  </channel>
</rss>`;

		const result = await parseWxr(createStream(wxr));

		expect(result.authors).toHaveLength(1);
		expect(result.authors[0]?.login).toBe("admin");
		expect(result.authors[0]?.email).toBe("admin@example.com");
		expect(result.authors[0]?.displayName).toBe("Administrator");
	});

	it("parses post meta", async () => {
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>Post with Meta</title>
      <wp:post_type>post</wp:post_type>
      <wp:postmeta>
        <wp:meta_key>_yoast_wpseo_title</wp:meta_key>
        <wp:meta_value>SEO Title</wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_yoast_wpseo_metadesc</wp:meta_key>
        <wp:meta_value>SEO Description</wp:meta_value>
      </wp:postmeta>
    </item>
  </channel>
</rss>`;

		const result = await parseWxr(createStream(wxr));

		expect(result.posts[0]?.meta.get("_yoast_wpseo_title")).toBe("SEO Title");
		expect(result.posts[0]?.meta.get("_yoast_wpseo_metadesc")).toBe("SEO Description");
	});

	it("handles empty WXR", async () => {
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Empty Site</title>
  </channel>
</rss>`;

		const result = await parseWxr(createStream(wxr));

		expect(result.posts).toHaveLength(0);
		expect(result.attachments).toHaveLength(0);
		expect(result.categories).toHaveLength(0);
	});

	it("parses page hierarchy (post_parent and menu_order)", async () => {
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>Parent Page</title>
      <wp:post_id>10</wp:post_id>
      <wp:post_type>page</wp:post_type>
      <wp:post_parent>0</wp:post_parent>
      <wp:menu_order>1</wp:menu_order>
    </item>
    <item>
      <title>Child Page</title>
      <wp:post_id>11</wp:post_id>
      <wp:post_type>page</wp:post_type>
      <wp:post_parent>10</wp:post_parent>
      <wp:menu_order>2</wp:menu_order>
    </item>
  </channel>
</rss>`;

		const result = await parseWxr(createStream(wxr));

		expect(result.posts).toHaveLength(2);
		expect(result.posts[0]?.postParent).toBe(0);
		expect(result.posts[0]?.menuOrder).toBe(1);
		expect(result.posts[1]?.postParent).toBe(10);
		expect(result.posts[1]?.menuOrder).toBe(2);
	});

	it("parses generic wp:term elements (custom taxonomies)", async () => {
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <wp:term>
      <wp:term_id>100</wp:term_id>
      <wp:term_taxonomy>genre</wp:term_taxonomy>
      <wp:term_slug>sci-fi</wp:term_slug>
      <wp:term_name><![CDATA[Science Fiction]]></wp:term_name>
      <wp:term_description><![CDATA[Science fiction books]]></wp:term_description>
    </wp:term>
    <wp:term>
      <wp:term_id>101</wp:term_id>
      <wp:term_taxonomy>genre</wp:term_taxonomy>
      <wp:term_slug>fantasy</wp:term_slug>
      <wp:term_name><![CDATA[Fantasy]]></wp:term_name>
      <wp:term_parent>sci-fi</wp:term_parent>
    </wp:term>
  </channel>
</rss>`;

		const result = await parseWxr(createStream(wxr));

		expect(result.terms).toHaveLength(2);
		expect(result.terms[0]?.id).toBe(100);
		expect(result.terms[0]?.taxonomy).toBe("genre");
		expect(result.terms[0]?.slug).toBe("sci-fi");
		expect(result.terms[0]?.name).toBe("Science Fiction");
		expect(result.terms[0]?.description).toBe("Science fiction books");
		expect(result.terms[1]?.parent).toBe("sci-fi");
	});

	it("parses nav_menu terms and nav_menu_item posts into structured menus", async () => {
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <wp:term>
      <wp:term_id>5</wp:term_id>
      <wp:term_taxonomy>nav_menu</wp:term_taxonomy>
      <wp:term_slug>main-menu</wp:term_slug>
      <wp:term_name><![CDATA[Main Menu]]></wp:term_name>
    </wp:term>
    <item>
      <title>Home</title>
      <wp:post_id>50</wp:post_id>
      <wp:post_type>nav_menu_item</wp:post_type>
      <wp:menu_order>1</wp:menu_order>
      <category domain="nav_menu" nicename="main-menu"><![CDATA[Main Menu]]></category>
      <wp:postmeta>
        <wp:meta_key>_menu_item_type</wp:meta_key>
        <wp:meta_value>custom</wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_menu_item_url</wp:meta_key>
        <wp:meta_value>https://example.com/</wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_menu_item_menu_item_parent</wp:meta_key>
        <wp:meta_value>0</wp:meta_value>
      </wp:postmeta>
    </item>
    <item>
      <title>About</title>
      <wp:post_id>51</wp:post_id>
      <wp:post_type>nav_menu_item</wp:post_type>
      <wp:menu_order>2</wp:menu_order>
      <category domain="nav_menu" nicename="main-menu"><![CDATA[Main Menu]]></category>
      <wp:postmeta>
        <wp:meta_key>_menu_item_type</wp:meta_key>
        <wp:meta_value>post_type</wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_menu_item_object</wp:meta_key>
        <wp:meta_value>page</wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_menu_item_object_id</wp:meta_key>
        <wp:meta_value>10</wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_menu_item_menu_item_parent</wp:meta_key>
        <wp:meta_value>0</wp:meta_value>
      </wp:postmeta>
    </item>
  </channel>
</rss>`;

		const result = await parseWxr(createStream(wxr));

		// Check terms array includes nav_menu term
		expect(result.terms.some((t) => t.taxonomy === "nav_menu")).toBe(true);

		// Check nav_menu_item posts are in posts array
		expect(result.posts.filter((p) => p.postType === "nav_menu_item")).toHaveLength(2);

		// Check structured navMenus
		expect(result.navMenus).toHaveLength(1);
		expect(result.navMenus[0]?.name).toBe("main-menu");
		expect(result.navMenus[0]?.id).toBe(5);
		expect(result.navMenus[0]?.items).toHaveLength(2);

		// Check menu items are sorted by menu_order
		expect(result.navMenus[0]?.items[0]?.title).toBe("Home");
		expect(result.navMenus[0]?.items[0]?.type).toBe("custom");
		expect(result.navMenus[0]?.items[0]?.url).toBe("https://example.com/");
		expect(result.navMenus[0]?.items[0]?.sortOrder).toBe(1);

		expect(result.navMenus[0]?.items[1]?.title).toBe("About");
		expect(result.navMenus[0]?.items[1]?.type).toBe("post_type");
		expect(result.navMenus[0]?.items[1]?.objectType).toBe("page");
		expect(result.navMenus[0]?.items[1]?.objectId).toBe(10);
		expect(result.navMenus[0]?.items[1]?.sortOrder).toBe(2);
	});

	it("parses custom taxonomy assignments on posts", async () => {
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>Book Review</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <category domain="category" nicename="reviews"><![CDATA[Reviews]]></category>
      <category domain="genre" nicename="sci-fi"><![CDATA[Science Fiction]]></category>
      <category domain="genre" nicename="dystopian"><![CDATA[Dystopian]]></category>
      <category domain="reading_level" nicename="advanced"><![CDATA[Advanced]]></category>
    </item>
  </channel>
</rss>`;

		const result = await parseWxr(createStream(wxr));

		expect(result.posts[0]?.categories).toContain("reviews");
		expect(result.posts[0]?.customTaxonomies?.get("genre")).toContain("sci-fi");
		expect(result.posts[0]?.customTaxonomies?.get("genre")).toContain("dystopian");
		expect(result.posts[0]?.customTaxonomies?.get("reading_level")).toContain("advanced");
	});

	describe("multilingual plugin metadata (issue #1080)", () => {
		it("promotes WPML _icl_lang_code and trid to locale + translationGroup", async () => {
			const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>Hello</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:post_name>hello</wp:post_name>
      <wp:postmeta>
        <wp:meta_key>_icl_lang_code</wp:meta_key>
        <wp:meta_value><![CDATA[en]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_icl_translation_id</wp:meta_key>
        <wp:meta_value><![CDATA[42]]></wp:meta_value>
      </wp:postmeta>
    </item>
    <item>
      <title>Mərhəba</title>
      <wp:post_id>2</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:post_name>hello</wp:post_name>
      <wp:postmeta>
        <wp:meta_key>_icl_lang_code</wp:meta_key>
        <wp:meta_value><![CDATA[ar]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_icl_translation_id</wp:meta_key>
        <wp:meta_value><![CDATA[42]]></wp:meta_value>
      </wp:postmeta>
    </item>
  </channel>
</rss>`;

			const result = await parseWxr(createStream(wxr));

			expect(result.posts).toHaveLength(2);
			expect(result.posts[0]?.locale).toBe("en");
			expect(result.posts[1]?.locale).toBe("ar");
			// Both translations share the same group key. Prefix is opaque
			// but stable so the execute route can group on it.
			expect(result.posts[0]?.translationGroup).toBe(result.posts[1]?.translationGroup);
			expect(result.posts[0]?.translationGroup).toContain("42");
		});

		it("falls back to WPML legacy `trid` meta key when _icl_translation_id is absent", async () => {
			const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>Legacy</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:postmeta>
        <wp:meta_key>_icl_lang_code</wp:meta_key>
        <wp:meta_value><![CDATA[fr]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>trid</wp:meta_key>
        <wp:meta_value><![CDATA[7]]></wp:meta_value>
      </wp:postmeta>
    </item>
  </channel>
</rss>`;

			const result = await parseWxr(createStream(wxr));

			expect(result.posts[0]?.locale).toBe("fr");
			expect(result.posts[0]?.translationGroup).toContain("7");
		});

		it("derives locale from Polylang's `language` taxonomy when WPML is absent", async () => {
			const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>Bonjour</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <category domain="language" nicename="fr"><![CDATA[Français]]></category>
    </item>
  </channel>
</rss>`;

			const result = await parseWxr(createStream(wxr));

			expect(result.posts[0]?.locale).toBe("fr");
		});

		it("derives a stable Polylang translationGroup from _translations meta", async () => {
			// Polylang stores `_translations` as a serialized PHP map. We
			// hash the post IDs into a stable key shared by every member of
			// the group. The exact format isn't part of the contract -- the
			// only guarantee is "same map -> same key".
			const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>EN</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <category domain="language" nicename="en"><![CDATA[English]]></category>
      <wp:postmeta>
        <wp:meta_key>_translations</wp:meta_key>
        <wp:meta_value><![CDATA[a:2:{s:2:"en";i:1;s:2:"fr";i:2;}]]></wp:meta_value>
      </wp:postmeta>
    </item>
    <item>
      <title>FR</title>
      <wp:post_id>2</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <category domain="language" nicename="fr"><![CDATA[Français]]></category>
      <wp:postmeta>
        <wp:meta_key>_translations</wp:meta_key>
        <wp:meta_value><![CDATA[a:2:{s:2:"en";i:1;s:2:"fr";i:2;}]]></wp:meta_value>
      </wp:postmeta>
    </item>
  </channel>
</rss>`;

			const result = await parseWxr(createStream(wxr));

			expect(result.posts).toHaveLength(2);
			expect(result.posts[0]?.locale).toBe("en");
			expect(result.posts[1]?.locale).toBe("fr");
			expect(result.posts[0]?.translationGroup).toBeDefined();
			expect(result.posts[0]?.translationGroup).toBe(result.posts[1]?.translationGroup);
		});

		it("leaves locale/translationGroup undefined on monolingual exports", async () => {
			const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>Mono</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
    </item>
  </channel>
</rss>`;

			const result = await parseWxr(createStream(wxr));

			expect(result.posts[0]?.locale).toBeUndefined();
			expect(result.posts[0]?.translationGroup).toBeUndefined();
		});

		it("prefers WPML over Polylang when both are present", async () => {
			const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>Conflict</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <category domain="language" nicename="fr"><![CDATA[Français]]></category>
      <wp:postmeta>
        <wp:meta_key>_icl_lang_code</wp:meta_key>
        <wp:meta_value><![CDATA[en]]></wp:meta_value>
      </wp:postmeta>
    </item>
  </channel>
</rss>`;

			const result = await parseWxr(createStream(wxr));

			expect(result.posts[0]?.locale).toBe("en");
		});

		it("handles Polylang _translations payloads with multibyte string keys", async () => {
			// PHP `s:LEN:"..."` counts BYTES of the payload, not chars. A
			// payload like `é` (2 bytes UTF-8) would shift JS UTF-16
			// position by 1, but the byte length is 2. The parser must
			// advance by bytes or it will misalign and drop subsequent
			// integer tokens.
			//
			// Real-world trigger: any non-ASCII locale code or label string
			// in `_translations`. We don't expect Polylang to produce such
			// keys, but the parser must not corrupt the group when it
			// does.
			const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>A</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:postmeta>
        <wp:meta_key>_translations</wp:meta_key>
        <wp:meta_value><![CDATA[a:2:{s:2:"é";i:1;s:2:"fr";i:2;}]]></wp:meta_value>
      </wp:postmeta>
    </item>
    <item>
      <title>B</title>
      <wp:post_id>2</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:postmeta>
        <wp:meta_key>_translations</wp:meta_key>
        <wp:meta_value><![CDATA[a:2:{s:2:"é";i:1;s:2:"fr";i:2;}]]></wp:meta_value>
      </wp:postmeta>
    </item>
  </channel>
</rss>`;

			const result = await parseWxr(createStream(wxr));

			expect(result.posts).toHaveLength(2);
			// Both ids extracted; group key has BOTH 1 and 2, not just 2.
			expect(result.posts[0]?.translationGroup).toBe("pll:1,2");
			expect(result.posts[1]?.translationGroup).toBe("pll:1,2");
		});

		it("ignores `i:N;` literals embedded inside Polylang `_translations` string values", async () => {
			// String values can contain `i:N;` text that the naive regex
			// would erroneously match. The length-aware parser walks
			// `s:LEN:"..."` blocks and skips their payloads exactly.
			// The real translation IDs are `i:1;` and `i:7;`; the embedded
			// `i:99;` inside a string value must NOT contribute.
			const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>A</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <category domain="language" nicename="en"><![CDATA[English]]></category>
      <wp:postmeta>
        <wp:meta_key>_translations</wp:meta_key>
        <wp:meta_value><![CDATA[a:2:{s:9:"junk i:99;";i:1;s:2:"ar";i:7;}]]></wp:meta_value>
      </wp:postmeta>
    </item>
    <item>
      <title>B</title>
      <wp:post_id>2</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <category domain="language" nicename="ar"><![CDATA[Arabic]]></category>
      <wp:postmeta>
        <wp:meta_key>_translations</wp:meta_key>
        <wp:meta_value><![CDATA[a:2:{s:9:"junk i:99;";i:1;s:2:"ar";i:7;}]]></wp:meta_value>
      </wp:postmeta>
    </item>
  </channel>
</rss>`;

			const result = await parseWxr(createStream(wxr));

			expect(result.posts).toHaveLength(2);
			const groupA = result.posts[0]?.translationGroup;
			const groupB = result.posts[1]?.translationGroup;
			expect(groupA).toBe(groupB);
			// Group key derives from the integer post IDs, not the
			// embedded `99` -- post-id list is `[1, 7]`.
			expect(groupA).toBe("pll:1,7");
		});

		it("falls back to _icl_translation_id when trid is absent", async () => {
			// `trid` is preferred (it's the shared translation group id),
			// but legacy / partial exports may only have
			// `_icl_translation_id`. Accept it as a fallback so single-
			// translation exports still get a group key.
			const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>Solo</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:postmeta>
        <wp:meta_key>_icl_lang_code</wp:meta_key>
        <wp:meta_value><![CDATA[en]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_icl_translation_id</wp:meta_key>
        <wp:meta_value><![CDATA[99]]></wp:meta_value>
      </wp:postmeta>
    </item>
  </channel>
</rss>`;

			const result = await parseWxr(createStream(wxr));
			expect(result.posts[0]?.locale).toBe("en");
			expect(result.posts[0]?.translationGroup).toBe("wpml:99");
		});

		it("captures per-item category text body as a taxonomyLabels entry", async () => {
			const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>Hello</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <category domain="category" nicename="breaking-news"><![CDATA[Breaking News]]></category>
      <category domain="post_tag" nicename="featured"><![CDATA[Featured]]></category>
      <category domain="genre" nicename="sci-fi"><![CDATA[Science Fiction]]></category>
    </item>
  </channel>
</rss>`;

			const result = await parseWxr(createStream(wxr));
			const post = result.posts[0];
			expect(post?.taxonomyLabels).toBeDefined();
			// Keys are `${normalisedTaxonomy}\u0000${slug}`. `post_tag`
			// normalises to `tag`.
			expect(post?.taxonomyLabels?.get("category\u0000breaking-news")).toBe("Breaking News");
			expect(post?.taxonomyLabels?.get("tag\u0000featured")).toBe("Featured");
			expect(post?.taxonomyLabels?.get("genre\u0000sci-fi")).toBe("Science Fiction");
		});
	});
});
