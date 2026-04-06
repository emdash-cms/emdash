/**
 * Tests for the main Gutenberg to Portable Text converter
 */

import { describe, it, expect } from "vitest";

import { gutenbergToPortableText, htmlToPortableText, parseGutenbergBlocks } from "../src/index.js";
import type {
	PortableTextTextBlock,
	PortableTextImageBlock,
	PortableTextGalleryBlock,
	PortableTextTableBlock,
	PortableTextButtonsBlock,
} from "../src/types.js";

const HTML_TAG_PATTERN = /<[^>]+>/g;
const knownProviders = [
	["youtube.com", "youtube"],
	["youtu.be", "youtube"],
	["vimeo.com", "vimeo"],
	["twitter.com", "twitter"],
	["x.com", "twitter"],
	["instagram.com", "instagram"],
	["facebook.com", "facebook"],
	["tiktok.com", "tiktok"],
	["spotify.com", "spotify"],
	["soundcloud.com", "soundcloud"],
	["codepen.io", "codepen"],
	["gist.github.com", "gist"],
] as const;

describe("gutenbergToPortableText", () => {
	describe("empty content", () => {
		it("returns empty array for empty string", () => {
			expect(gutenbergToPortableText("")).toEqual([]);
		});

		it("returns empty array for whitespace", () => {
			expect(gutenbergToPortableText("   \n\t  ")).toEqual([]);
		});

		it("returns empty array for null-ish values", () => {
			expect(gutenbergToPortableText(null as unknown as string)).toEqual([]);
			expect(gutenbergToPortableText(undefined as unknown as string)).toEqual([]);
		});
	});

	describe("basic HTML content", () => {
		it("converts simple HTML to a paragraph block", () => {
			const content = "<p>Hello world</p>";
			const result = gutenbergToPortableText(content);
			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				_type: "block",
				style: "normal",
			});
			const block = result[0] as PortableTextTextBlock;
			expect(block.children[0]?.text).toBe("Hello world");
		});

		it("converts mixed blocks and text", () => {
			const content = `<p>Intro text</p>weird middle text<p>More text</p>`;
			const result = gutenbergToPortableText(content);

			expect(result).toHaveLength(3);
			expect(result[0]).toMatchObject({
				_type: "block",
				style: "normal",
			});
			expect(result[1]).toMatchObject({
				_type: "block",
				style: "normal",
			});
			expect(result[2]).toMatchObject({
				_type: "block",
				style: "normal",
			});

			const block1 = result[0] as PortableTextTextBlock;
			const block2 = result[1] as PortableTextTextBlock;
			const block3 = result[2] as PortableTextTextBlock;

			expect(block1.children[0]?.text).toBe("Intro text");
			expect(block2.children[0]?.text).toBe("weird middle text");
			expect(block3.children[0]?.text).toBe("More text");
		});

		it("handles trailing text content", () => {
			const content = `<p>Paragraph text</p>Trailing text`;
			const result = gutenbergToPortableText(content);

			expect(result).toHaveLength(2);
			expect(result[0]).toMatchObject({
				_type: "block",
				style: "normal",
			});
			expect(result[1]).toMatchObject({
				_type: "block",
				style: "normal",
			});

			const block1 = result[0] as PortableTextTextBlock;
			const block2 = result[1] as PortableTextTextBlock;

			expect(block1.children[0]?.text).toBe("Paragraph text");
			expect(block2.children[0]?.text).toBe("Trailing text");
		});
	});

	describe("paragraph blocks", () => {
		it("converts simple paragraph", () => {
			const content = `<!-- wp:paragraph -->
<p>Hello world</p>
<!-- /wp:paragraph -->`;

			const result = gutenbergToPortableText(content);

			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				_type: "block",
				style: "normal",
			});
			const block = result[0] as PortableTextTextBlock;
			expect(block.children[0]?.text).toBe("Hello world");
		});

		it("converts paragraph with inline formatting", () => {
			const content = `<!-- wp:paragraph -->
<p>Hello <strong>bold</strong> and <em>italic</em> world</p>
<!-- /wp:paragraph -->`;

			const result = gutenbergToPortableText(content);
			const block = result[0] as PortableTextTextBlock;

			expect(block.children.length).toBeGreaterThan(1);
			const boldSpan = block.children.find((c) => c.marks?.includes("strong"));
			const italicSpan = block.children.find((c) => c.marks?.includes("em"));
			expect(boldSpan?.text).toBe("bold");
			expect(italicSpan?.text).toBe("italic");
		});

		it("converts paragraph with link", () => {
			const content = `<!-- wp:paragraph -->
<p>Visit <a href="https://example.com">our site</a></p>
<!-- /wp:paragraph -->`;

			const result = gutenbergToPortableText(content);
			const block = result[0] as PortableTextTextBlock;

			expect(block.markDefs).toHaveLength(1);
			expect(block.markDefs?.[0]).toMatchObject({
				_type: "link",
				href: "https://example.com",
			});
		});

		it("skips empty paragraphs", () => {
			const content = `<!-- wp:paragraph -->
<p></p>
<!-- /wp:paragraph -->`;

			const result = gutenbergToPortableText(content);
			expect(result).toHaveLength(0);
		});

		it("handles multiple paragraphs", () => {
			const content = `<!-- wp:paragraph -->
<p>First paragraph</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph -->
<p>Second paragraph</p>
<!-- /wp:paragraph -->`;

			const result = gutenbergToPortableText(content);
			expect(result).toHaveLength(2);
		});
	});

	describe("heading blocks", () => {
		it("converts h1", () => {
			const content = `<!-- wp:heading {"level":1} -->
<h1>Main Title</h1>
<!-- /wp:heading -->`;

			const result = gutenbergToPortableText(content);
			expect(result[0]).toMatchObject({
				_type: "block",
				style: "h1",
			});
		});

		it("converts h2 (default level)", () => {
			const content = `<!-- wp:heading -->
<h2>Subtitle</h2>
<!-- /wp:heading -->`;

			const result = gutenbergToPortableText(content);
			expect(result[0]).toMatchObject({
				_type: "block",
				style: "h2",
			});
		});

		it("converts h3-h6", () => {
			for (let level = 3; level <= 6; level++) {
				const content = `<!-- wp:heading {"level":${level}} -->
<h${level}>Heading ${level}</h${level}>
<!-- /wp:heading -->`;

				const result = gutenbergToPortableText(content);
				expect(result[0]).toMatchObject({
					_type: "block",
					style: `h${level}`,
				});
			}
		});

		it("preserves formatting in headings", () => {
			const content = `<!-- wp:heading {"level":2} -->
<h2>Title with <strong>bold</strong></h2>
<!-- /wp:heading -->`;

			const result = gutenbergToPortableText(content);
			const block = result[0] as PortableTextTextBlock;
			const boldSpan = block.children.find((c) => c.marks?.includes("strong"));
			expect(boldSpan?.text).toBe("bold");
		});
	});

	describe("list blocks", () => {
		it("converts unordered list", () => {
			const content = `<!-- wp:list -->
<ul>
<li>Item one</li>
<li>Item two</li>
<li>Item three</li>
</ul>
<!-- /wp:list -->`;

			const result = gutenbergToPortableText(content);

			expect(result).toHaveLength(3);
			result.forEach((block) => {
				expect(block).toMatchObject({
					_type: "block",
					listItem: "bullet",
					level: 1,
				});
			});
		});

		it("converts ordered list", () => {
			const content = `<!-- wp:list {"ordered":true} -->
<ol>
<li>First</li>
<li>Second</li>
</ol>
<!-- /wp:list -->`;

			const result = gutenbergToPortableText(content);

			expect(result).toHaveLength(2);
			result.forEach((block) => {
				expect(block).toMatchObject({
					_type: "block",
					listItem: "number",
					level: 1,
				});
			});
		});

		it("preserves formatting in list items", () => {
			const content = `<!-- wp:list -->
<ul>
<li>Item with <strong>bold</strong></li>
</ul>
<!-- /wp:list -->`;

			const result = gutenbergToPortableText(content);
			const block = result[0] as PortableTextTextBlock;
			const boldSpan = block.children.find((c) => c.marks?.includes("strong"));
			expect(boldSpan?.text).toBe("bold");
		});

		it("handles nested lists", () => {
			const content = `<!-- wp:list -->
<ul>
<li>Parent item
<ul>
<li>Nested item</li>
</ul>
</li>
</ul>
<!-- /wp:list -->`;

			const result = gutenbergToPortableText(content);

			const level1 = result.filter((b) => (b as PortableTextTextBlock).level === 1);
			const level2 = result.filter((b) => (b as PortableTextTextBlock).level === 2);

			expect(level1.length).toBeGreaterThanOrEqual(1);
			expect(level2.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("quote blocks", () => {
		it("converts simple quote", () => {
			const content = `<!-- wp:quote -->
<blockquote class="wp-block-quote"><p>To be or not to be</p></blockquote>
<!-- /wp:quote -->`;

			const result = gutenbergToPortableText(content);

			expect(result[0]).toMatchObject({
				_type: "block",
				style: "blockquote",
			});
		});

		it("handles quote with citation", () => {
			const content = `<!-- wp:quote {"citation":"Shakespeare"} -->
<blockquote class="wp-block-quote"><p>To be or not to be</p></blockquote>
<!-- /wp:quote -->`;

			const result = gutenbergToPortableText(content);

			// Should have quote block + citation block
			expect(result.length).toBeGreaterThanOrEqual(1);
			expect(result[0]).toMatchObject({
				_type: "block",
				style: "blockquote",
			});
		});

		it("handles multi-paragraph quote", () => {
			const content = `<!-- wp:quote -->
<blockquote class="wp-block-quote">
<p>First paragraph of quote</p>
<p>Second paragraph of quote</p>
</blockquote>
<!-- /wp:quote -->`;

			const result = gutenbergToPortableText(content);

			const quoteBlocks = result.filter((b) => (b as PortableTextTextBlock).style === "blockquote");
			expect(quoteBlocks).toHaveLength(2);
		});
	});

	describe("image blocks", () => {
		it("converts image with URL in attrs", () => {
			const content = `<!-- wp:image {"id":123,"sizeSlug":"large","url":"https://example.com/photo.jpg"} -->
<figure class="wp-block-image size-large"><img src="https://example.com/photo.jpg" alt="A photo" class="wp-image-123"/></figure>
<!-- /wp:image -->`;

			const result = gutenbergToPortableText(content);

			expect(result[0]).toMatchObject({
				_type: "image",
				alt: "A photo",
			});
			const img = result[0] as PortableTextImageBlock;
			expect(img.asset.url).toBe("https://example.com/photo.jpg");
		});

		it("extracts image from HTML when not in attrs", () => {
			const content = `<!-- wp:image {"id":123} -->
<figure class="wp-block-image"><img src="https://example.com/photo.jpg" alt="Photo"/></figure>
<!-- /wp:image -->`;

			const result = gutenbergToPortableText(content);
			const img = result[0] as PortableTextImageBlock;

			expect(img.asset.url).toBe("https://example.com/photo.jpg");
			expect(img.alt).toBe("Photo");
		});

		it("extracts caption from figcaption", () => {
			const content = `<!-- wp:image {"id":123} -->
<figure class="wp-block-image"><img src="photo.jpg"/><figcaption>My caption</figcaption></figure>
<!-- /wp:image -->`;

			const result = gutenbergToPortableText(content);
			const img = result[0] as PortableTextImageBlock;

			expect(img.caption).toBe("My caption");
		});

		it("uses media map when provided", () => {
			const content = `<!-- wp:image {"id":123} -->
<figure><img src="photo.jpg"/></figure>
<!-- /wp:image -->`;

			const mediaMap = new Map([[123, "emdash-media-abc"]]);
			const result = gutenbergToPortableText(content, { mediaMap });
			const img = result[0] as PortableTextImageBlock;

			expect(img.asset._ref).toBe("emdash-media-abc");
		});

		it("handles alignment", () => {
			const content = `<!-- wp:image {"id":123,"align":"center"} -->
<figure class="wp-block-image aligncenter"><img src="photo.jpg"/></figure>
<!-- /wp:image -->`;

			const result = gutenbergToPortableText(content);
			const img = result[0] as PortableTextImageBlock;

			expect(img.alignment).toBe("center");
		});
	});

	describe("code blocks", () => {
		it("converts code block", () => {
			const content = `<!-- wp:code -->
<pre class="wp-block-code"><code>const x = 1;</code></pre>
<!-- /wp:code -->`;

			const result = gutenbergToPortableText(content);

			expect(result[0]).toMatchObject({
				_type: "code",
				code: "const x = 1;",
			});
		});

		it("preserves language attribute", () => {
			const content = `<!-- wp:code {"language":"javascript"} -->
<pre class="wp-block-code"><code>const x = 1;</code></pre>
<!-- /wp:code -->`;

			const result = gutenbergToPortableText(content);

			expect(result[0]).toMatchObject({
				_type: "code",
				language: "javascript",
			});
		});

		it("decodes HTML entities in code", () => {
			const content = `<!-- wp:code -->
<pre class="wp-block-code"><code>&lt;div&gt;Hello&lt;/div&gt;</code></pre>
<!-- /wp:code -->`;

			const result = gutenbergToPortableText(content);

			expect(result[0]).toMatchObject({
				_type: "code",
				code: "<div>Hello</div>",
			});
		});

		it("handles multiline code", () => {
			const content = `<!-- wp:code -->
<pre class="wp-block-code"><code>function hello() {
  return "world";
}</code></pre>
<!-- /wp:code -->`;

			const result = gutenbergToPortableText(content);

			expect((result[0] as { code: string }).code).toContain("\n");
		});
	});

	describe("embed blocks", () => {
		it("converts YouTube embed", () => {
			const content = `<!-- wp:embed {"url":"https://www.youtube.com/watch?v=abc123","type":"video","providerNameSlug":"youtube"} -->
<figure class="wp-block-embed is-type-video is-provider-youtube">
<div class="wp-block-embed__wrapper">
https://www.youtube.com/watch?v=abc123
</div>
</figure>
<!-- /wp:embed -->`;

			const result = gutenbergToPortableText(content);

			expect(result[0]).toMatchObject({
				_type: "embed",
				url: "https://www.youtube.com/watch?v=abc123",
				provider: "youtube",
			});
		});

		it("converts Twitter embed", () => {
			const content = `<!-- wp:embed {"url":"https://twitter.com/user/status/123","type":"rich","providerNameSlug":"twitter"} -->
<figure class="wp-block-embed is-provider-twitter">
<div class="wp-block-embed__wrapper">
https://twitter.com/user/status/123
</div>
</figure>
<!-- /wp:embed -->`;

			const result = gutenbergToPortableText(content);

			expect(result[0]).toMatchObject({
				_type: "embed",
				provider: "twitter",
			});
		});

		it.each(knownProviders)(
			"detects provider from URL when not specified for %s",
			(domain, provider) => {
				const content = `<!-- wp:embed {"url":"https://${domain}/123456"} -->
<figure class="wp-block-embed">
<div class="wp-block-embed__wrapper">
https://${domain}/123456
</div>
</figure>
<!-- /wp:embed -->`;

				const result = gutenbergToPortableText(content);

				expect(result[0]).toMatchObject({
					_type: "embed",
					provider,
				});
			},
		);

		it("converts audio embeds", () => {
			const content = `<!-- wp:audio {"src":"https://example.com/audio.mp3"} -->
<figure class="wp-block-audio"><audio controls src="https://example.com/audio.mp3"></audio></figure>
<!-- /wp:audio -->`;

			const result = gutenbergToPortableText(content);
			expect(result[0]).toMatchObject({
				_type: "embed",
				url: "https://example.com/audio.mp3",
				provider: "audio",
			});
		});

		it("converts video embeds", () => {
			const content = `<!-- wp:video {"src":"https://example.com/video.mp4"} -->
<figure class="wp-block-video"><video controls src="https://example.com/video.mp4"></video></figure>
<!-- /wp:video -->`;

			const result = gutenbergToPortableText(content);
			expect(result[0]).toMatchObject({
				_type: "embed",
				url: "https://example.com/video.mp4",
				provider: "video",
			});
		});

		it("infers video source from <video> tag when URL not in attrs", () => {
			const content = `<!-- wp:video -->
<figure class="wp-block-video"><video controls src="https://example.com/video.mp4"></video></figure>
<!-- /wp:video -->`;

			const result = gutenbergToPortableText(content);
			expect(result[0]).toMatchObject({
				_type: "embed",
				url: "https://example.com/video.mp4",
				provider: "video",
			});
		});

		it("infers audio source from <audio> tag when URL not in attrs", () => {
			const content = `<!-- wp:audio -->
<figure class="wp-block-audio"><audio controls src="https://example.com/audio.mp3"></audio></figure>
<!-- /wp:audio -->`;

			const result = gutenbergToPortableText(content);
			expect(result[0]).toMatchObject({
				_type: "embed",
				url: "https://example.com/audio.mp3",
				provider: "audio",
			});
		});
	});

	describe("separator/spacer blocks", () => {
		it("converts separator to break", () => {
			const content = `<!-- wp:separator -->
<hr class="wp-block-separator"/>
<!-- /wp:separator -->`;

			const result = gutenbergToPortableText(content);

			expect(result[0]).toMatchObject({
				_type: "break",
				style: "lineBreak",
			});
		});

		it("converts spacer to break", () => {
			const content = `<!-- wp:spacer {"height":"50px"} -->
<div style="height:50px" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->`;

			const result = gutenbergToPortableText(content);

			expect(result[0]).toMatchObject({
				_type: "break",
			});
		});
	});

	describe("columns blocks", () => {
		it("converts columns with content", () => {
			const content = `<!-- wp:columns -->
<div class="wp-block-columns">
<!-- wp:column -->
<div class="wp-block-column">
<!-- wp:paragraph -->
<p>Column 1</p>
<!-- /wp:paragraph -->
</div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column">
<!-- wp:paragraph -->
<p>Column 2</p>
<!-- /wp:paragraph -->
</div>
<!-- /wp:column -->
</div>
<!-- /wp:columns -->`;

			const result = gutenbergToPortableText(content);

			expect(result[0]).toMatchObject({
				_type: "columns",
			});
			const cols = result[0] as { columns: Array<{ content: unknown[] }> };
			expect(cols.columns).toHaveLength(2);
			expect(cols.columns[0]?.content.length).toBeGreaterThan(0);
		});
	});

	describe("table blocks", () => {
		it("converts table with header and body", () => {
			const content = `<!-- wp:table -->
<figure class="wp-block-table">
<table>
<thead><tr><th>Name</th><th>Age</th><th>Country</th></tr></thead>
<tbody>
<tr><td>James</td><td>83</td><td>UK</td></tr>
<tr><td>Bob</td><td>92</td><td>Canada</td></tr>
</tbody>
</table>
</figure>
<!-- /wp:table -->`;

			const result = gutenbergToPortableText(content);

			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				_type: "table",
				hasHeaderRow: true,
			});

			const tbl = result[0] as PortableTextTableBlock;
			expect(tbl.rows).toHaveLength(3);

			const headerCells = tbl.rows[0]!.cells;
			expect(headerCells).toHaveLength(3);
			expect(headerCells.every((c) => c.isHeader === true)).toBe(true);
			expect(headerCells[0]!.content[0]!.text).toBe("Name");
			expect(headerCells[1]!.content[0]!.text).toBe("Age");
			expect(headerCells[2]!.content[0]!.text).toBe("Country");

			const firstBodyRow = tbl.rows[1]!.cells;
			expect(firstBodyRow[0]!.content[0]!.text).toBe("James");
			expect(firstBodyRow[1]!.content[0]!.text).toBe("83");
			expect(firstBodyRow[2]!.content[0]!.text).toBe("UK");
		});

		it("converts table with no header", () => {
			const content = `<!-- wp:table -->
<table>
<tbody>
<tr><td>One</td><td>Two</td></tr>
<tr><td>Three</td><td>Four</td></tr>
</tbody>
</table>
<!-- /wp:table -->`;

			const result = gutenbergToPortableText(content);

			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				_type: "table",
				hasHeaderRow: false,
			});

			const tbl = result[0] as PortableTextTableBlock;
			expect(tbl.rows).toHaveLength(2);
			expect(tbl.rows[0]!.cells[0]!.content[0]!.text).toBe("One");
			expect(tbl.rows[1]!.cells[0]!.content[0]!.text).toBe("Three");
			expect(tbl.rows[0]!.cells.every((c) => c.isHeader !== true)).toBe(true);
			expect(tbl.rows[1]!.cells.every((c) => c.isHeader !== true)).toBe(true);
		});
	});

	describe("button blocks", () => {
		it("converts button with default style (no className)", () => {
			const content = `<!-- wp:button {"url":"https://example.com"} -->
<div class="wp-block-button"><a href="https://example.com">Click me</a></div>
<!-- /wp:button -->`;

			const result = gutenbergToPortableText(content);

			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				_type: "button",
				text: "Click me",
				url: "https://example.com",
				style: "default",
			});
		});

		it("converts button with outline style", () => {
			const content = `<!-- wp:button {"url":"https://example.com","className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a href="https://example.com">Outline</a></div>
<!-- /wp:button -->`;

			const result = gutenbergToPortableText(content);

			expect(result[0]).toMatchObject({
				_type: "button",
				text: "Outline",
				style: "outline",
			});
		});

		it("falls back to default style for unrecognised className", () => {
			const content = `<!-- wp:button {"url":"https://example.com","className":"is-style-prolific-potato"} -->
<div class="wp-block-button is-style-prolific-potato"><a href="https://example.com">Boop</a></div>
<!-- /wp:button -->`;

			const result = gutenbergToPortableText(content);

			expect(result[0]).toMatchObject({
				_type: "button",
				text: "Boop",
				style: "default",
			});
		});

		it("converts button with fill style", () => {
			const content = `<!-- wp:button {"url":"https://example.com","className":"is-style-fill"} -->
<div class="wp-block-button is-style-fill"><a href="https://example.com">Fill</a></div>
<!-- /wp:button -->`;

			const result = gutenbergToPortableText(content);

			expect(result[0]).toMatchObject({
				_type: "button",
				text: "Fill",
				style: "fill",
			});
		});
	});

	describe("buttons block", () => {
		it("converts a buttons container", () => {
			const content = `<!-- wp:buttons -->
<div class="wp-block-buttons">
<!-- wp:button {"url":"https://example.com/one"} -->
<div class="wp-block-button"><a href="https://example.com/one">First</a></div>
<!-- /wp:button -->
<!-- wp:button {"url":"https://example.com/two"} -->
<div class="wp-block-button"><a href="https://example.com/two">Second</a></div>
<!-- /wp:button -->
</div>
<!-- /wp:buttons -->`;

			const result = gutenbergToPortableText(content);

			expect(result).toHaveLength(1);

			const block = result[0] as PortableTextButtonsBlock;
			expect(block._type).toBe("buttons");
			expect(block.buttons[0]).toMatchObject({ text: "First", url: "https://example.com/one" });
			expect(block.buttons[1]).toMatchObject({ text: "Second", url: "https://example.com/two" });
		});

		it("converts buttons with horizontal layout", () => {
			const content = `<!-- wp:buttons {"layout":{"type":"flex"}} -->
<div class="wp-block-buttons is-layout-flex">
<!-- wp:button {"url":"https://example.com/a"} -->
<div class="wp-block-button"><a href="https://example.com/a">A</a></div>
<!-- /wp:button -->
<!-- wp:button {"url":"https://example.com/b"} -->
<div class="wp-block-button"><a href="https://example.com/b">B</a></div>
<!-- /wp:button -->
</div>
<!-- /wp:buttons -->`;

			const result = gutenbergToPortableText(content);

			expect(result[0]).toMatchObject({ _type: "buttons", layout: "horizontal" });
		});

		it("converts buttons with mixed styles (outline/fill)", () => {
			const content = `<!-- wp:buttons -->
<div class="wp-block-buttons">
<!-- wp:button {"url":"https://example.com/outline","className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a href="https://example.com/outline">Outline</a></div>
<!-- /wp:button -->
<!-- wp:button {"url":"https://example.com/fill","className":"is-style-fill"} -->
<div class="wp-block-button is-style-fill"><a href="https://example.com/fill">Fill</a></div>
<!-- /wp:button -->
</div>
<!-- /wp:buttons -->`;

			const result = gutenbergToPortableText(content);

			const block = result[0] as PortableTextButtonsBlock;
			expect(block.buttons[0]).toMatchObject({ style: "outline" });
			expect(block.buttons[1]).toMatchObject({ style: "fill" });
		});
	});

	describe("gallery blocks", () => {
		it("converts gallery with inner image blocks", () => {
			const content = `<!-- wp:gallery {"columns":3} -->
<figure class="wp-block-gallery">
<!-- wp:image {"id":1,"url":"https://example.com/photo1.jpg"} -->
<figure class="wp-block-image"><img src="https://example.com/photo1.jpg" alt="Photo 1"></figure>
<!-- /wp:image -->
<!-- wp:image {"id":2,"url":"https://example.com/photo2.jpg"} -->
<figure class="wp-block-image"><img src="https://example.com/photo2.jpg" alt="Photo 2"></figure>
<!-- /wp:image -->
<!-- wp:image {"id":3,"url":"https://example.com/photo3.jpg"} -->
<figure class="wp-block-image"><img src="https://example.com/photo3.jpg" alt="Photo 3"><figcaption>Third photo</figcaption></figure>
<!-- /wp:image -->
</figure>
<!-- /wp:gallery -->`;

			const result = gutenbergToPortableText(content);

			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				_type: "gallery",
				columns: 3,
			});

			const gallery = result[0] as PortableTextGalleryBlock;
			expect(gallery.images).toHaveLength(3);
			expect(gallery.images[0]).toMatchObject({
				_type: "image",
				alt: "Photo 1",
				asset: { url: "https://example.com/photo1.jpg" },
			});
			expect(gallery.images[1]).toMatchObject({
				_type: "image",
				alt: "Photo 2",
				asset: { url: "https://example.com/photo2.jpg" },
			});
			expect(gallery.images[2]).toMatchObject({
				_type: "image",
				alt: "Photo 3",
				caption: "Third photo",
				asset: { url: "https://example.com/photo3.jpg" },
			});
		});
	});

	describe("group blocks", () => {
		it("flattens group block content", () => {
			const content = `<!-- wp:group -->
<div class="wp-block-group">
<!-- wp:paragraph -->
<p>Paragraph in group</p>
<!-- /wp:paragraph -->
<!-- wp:heading -->
<h2>Heading in group</h2>
<!-- /wp:heading -->
</div>
<!-- /wp:group -->`;

			const result = gutenbergToPortableText(content);

			// Group should be flattened - we get the inner blocks directly
			expect(result.some((b) => (b as PortableTextTextBlock).style === "normal")).toBe(true);
			expect(result.some((b) => (b as PortableTextTextBlock).style === "h2")).toBe(true);
		});
	});

	describe("unknown blocks", () => {
		it("creates htmlBlock fallback for unknown blocks", () => {
			const content = `<!-- wp:my-plugin/custom-block {"foo":"bar"} -->
<div class="custom-block">Custom content</div>
<!-- /wp:my-plugin/custom-block -->`;

			const result = gutenbergToPortableText(content);

			expect(result[0]).toMatchObject({
				_type: "htmlBlock",
				originalBlockName: "my-plugin/custom-block",
			});
			expect((result[0] as { html: string }).html).toContain("Custom content");
		});

		it("preserves original attrs in fallback", () => {
			const content = `<!-- wp:unknown/block {"setting":true,"count":5} -->
<div>Content</div>
<!-- /wp:unknown/block -->`;

			const result = gutenbergToPortableText(content);

			expect((result[0] as { originalAttrs: Record<string, unknown> }).originalAttrs).toMatchObject(
				{
					setting: true,
					count: 5,
				},
			);
		});
	});

	describe("custom transformers", () => {
		it("uses custom transformer when provided", () => {
			const content = `<!-- wp:my-plugin/testimonial {"rating":5} -->
<div class="testimonial">Great product!</div>
<!-- /wp:my-plugin/testimonial -->`;

			const result = gutenbergToPortableText(content, {
				customTransformers: {
					"my-plugin/testimonial": (block, _opts, ctx) => [
						{
							_type: "testimonial" as const,
							_key: ctx.generateKey(),
							text: block.innerHTML.replace(HTML_TAG_PATTERN, "").trim(),
							rating: block.attrs.rating as number,
						} as unknown as import("../src/types.js").PortableTextBlock,
					],
				},
			});

			expect(result[0]).toMatchObject({
				_type: "testimonial",
				text: "Great product!",
				rating: 5,
			});
		});
	});

	describe("mixed content", () => {
		it("handles complex document with multiple block types", () => {
			const content = `<!-- wp:heading {"level":1} -->
<h1>Welcome</h1>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>This is the <strong>introduction</strong>.</p>
<!-- /wp:paragraph -->

<!-- wp:image {"id":1} -->
<figure><img src="hero.jpg" alt="Hero"/></figure>
<!-- /wp:image -->

<!-- wp:list -->
<ul>
<li>Feature one</li>
<li>Feature two</li>
</ul>
<!-- /wp:list -->

<!-- wp:quote -->
<blockquote><p>A quote</p></blockquote>
<!-- /wp:quote -->`;

			const result = gutenbergToPortableText(content);

			// h1 + p + image + 2 list items + quote = 6 blocks
			expect(result.length).toBeGreaterThanOrEqual(5);

			const types = result.map((b) => b._type);
			expect(types).toContain("block");
			expect(types).toContain("image");
		});
	});
});

describe("htmlToPortableText", () => {
	it("converts simple HTML paragraphs", () => {
		const html = "<p>Hello world</p>";
		const result = htmlToPortableText(html);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			_type: "block",
			style: "normal",
		});
	});

	it("converts headings", () => {
		const html = "<h1>Title</h1><h2>Subtitle</h2>";
		const result = htmlToPortableText(html);

		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({ style: "h1" });
		expect(result[1]).toMatchObject({ style: "h2" });
	});

	it("converts lists", () => {
		const html = "<ul><li>One</li><li>Two</li></ul>";
		const result = htmlToPortableText(html);

		expect(result).toHaveLength(2);
		result.forEach((b) => {
			expect(b).toMatchObject({ listItem: "bullet" });
		});
	});

	it("converts blockquotes", () => {
		const html = "<blockquote>A quote</blockquote>";
		const result = htmlToPortableText(html);

		expect(result[0]).toMatchObject({
			_type: "block",
			style: "blockquote",
		});
	});

	it("converts code blocks", () => {
		const html = "<pre><code>const x = 1;</code></pre>";
		const result = htmlToPortableText(html);

		expect(result[0]).toMatchObject({
			_type: "code",
			code: "const x = 1;",
		});
	});

	it("converts horizontal rules", () => {
		const html = "<p>Before</p><hr><p>After</p>";
		const result = htmlToPortableText(html);

		const breakBlock = result.find((b) => b._type === "break");
		expect(breakBlock).toBeDefined();
	});

	it("handles inline formatting", () => {
		const html = "<p>Hello <strong>bold</strong> and <em>italic</em></p>";
		const result = htmlToPortableText(html);

		const block = result[0] as PortableTextTextBlock;
		expect(block.children.some((c) => c.marks?.includes("strong"))).toBe(true);
		expect(block.children.some((c) => c.marks?.includes("em"))).toBe(true);
	});
});

describe("WordPress.com classic editor content", () => {
	// Test case from sparge.wordpress.com - classic editor with linked images
	// and HTML entities in URLs (&#038; instead of &)
	const spargePostContent = `<p><a href="https://sparge.wordpress.com/wp-content/uploads/2011/11/hip-hop.jpg"><img data-attachment-id="238" data-permalink="https://sparge.wordpress.com/2011/11/27/now-brewing-hip-hop-nelson-sauvin/hip-hop/" data-orig-file="https://sparge.wordpress.com/wp-content/uploads/2011/11/hip-hop.jpg" data-orig-size="384,560" data-comments-opened="1" data-image-meta="{&quot;aperture&quot;:&quot;0&quot;,&quot;credit&quot;:&quot;&quot;,&quot;camera&quot;:&quot;&quot;,&quot;caption&quot;:&quot;&quot;,&quot;created_timestamp&quot;:&quot;0&quot;,&quot;copyright&quot;:&quot;&quot;,&quot;focal_length&quot;:&quot;0&quot;,&quot;iso&quot;:&quot;0&quot;,&quot;shutter_speed&quot;:&quot;0&quot;,&quot;title&quot;:&quot;&quot;}" data-image-title="hip-hop" data-image-description="" data-image-caption="" data-medium-file="https://sparge.wordpress.com/wp-content/uploads/2011/11/hip-hop.jpg?w=205" data-large-file="https://sparge.wordpress.com/wp-content/uploads/2011/11/hip-hop.jpg?w=384" class="alignright size-medium wp-image-238" title="hip-hop" src="https://sparge.wordpress.com/wp-content/uploads/2011/11/hip-hop.jpg?w=205&#038;h=300" alt="" width="205" height="300" /></a>Hip Hops Nelson Sauvin is the first of my Christmas brews.</p>
<p>It's inspired by <a href="http://www.brewdog.com/product/77-lager" target="_blank" rel="noopener">BrewDog 77</a>, which is a classic lager dry-hopped with Nelson Sauvin. OK, so Hip Hops is 6.3% rather than 4.9%, and uses ordinary Saaz in the boil, but the essence is the same: it's a delicious, crisp German-style lager, given a New Zealand accent with a big hit of Nelson Sauvin.</p>`;

	it("extracts linked images with decoded URLs", () => {
		const result = htmlToPortableText(spargePostContent);

		// Should have at least one image block
		const imageBlocks = result.filter((b) => b._type === "image");
		expect(imageBlocks.length).toBeGreaterThanOrEqual(1);

		// First block should be the image
		const img = imageBlocks[0];
		expect(img._type).toBe("image");

		// URL should have decoded HTML entities (& not &#038;)
		expect(img.asset.url).toBe(
			"https://sparge.wordpress.com/wp-content/uploads/2011/11/hip-hop.jpg?w=205&h=300",
		);
		expect(img.asset.url).not.toContain("&#038;");

		// Link should be preserved
		expect(img.link).toBe("https://sparge.wordpress.com/wp-content/uploads/2011/11/hip-hop.jpg");
	});

	it("preserves text content alongside images", () => {
		const result = htmlToPortableText(spargePostContent);

		// Should have text blocks with the paragraph content
		const textBlocks = result.filter((b) => b._type === "block");
		expect(textBlocks.length).toBeGreaterThanOrEqual(1);

		// Check that text content is preserved
		const allText = textBlocks.flatMap((b) => b.children.map((c) => c.text)).join("");
		expect(allText).toContain("Hip Hops Nelson Sauvin");
		expect(allText).toContain("Christmas brews");
	});

	it("preserves links in text", () => {
		const result = htmlToPortableText(spargePostContent);

		// Should have text blocks with links
		const textBlocks = result.filter((b) => b._type === "block");

		// Find block with BrewDog link
		const blockWithLink = textBlocks.find((b) => b.markDefs?.length);
		expect(blockWithLink).toBeDefined();
		expect(blockWithLink?.markDefs).toContainEqual(
			expect.objectContaining({
				_type: "link",
				href: "http://www.brewdog.com/product/77-lager",
			}),
		);
	});

	it("decodes HTML entities in standalone image src", () => {
		const html = `<img src="https://example.com/photo.jpg?w=200&#038;h=300" alt="test">`;
		const result = htmlToPortableText(html);

		expect(result).toHaveLength(1);
		const img = result[0] as PortableTextImageBlock;
		expect(img._type).toBe("image");
		expect(img.asset.url).toBe("https://example.com/photo.jpg?w=200&h=300");
	});

	it("decodes &#38; variant in URLs", () => {
		const html = `<p><img src="https://example.com/photo.jpg?a=1&#38;b=2" alt="test"></p>`;
		const result = htmlToPortableText(html);

		const img = result.find((b) => b._type === "image") as PortableTextImageBlock;
		expect(img.asset.url).toBe("https://example.com/photo.jpg?a=1&b=2");
	});

	it("decodes &amp; in URLs", () => {
		const html = `<p><img src="https://example.com/photo.jpg?a=1&amp;b=2" alt="test"></p>`;
		const result = htmlToPortableText(html);

		const img = result.find((b) => b._type === "image") as PortableTextImageBlock;
		expect(img.asset.url).toBe("https://example.com/photo.jpg?a=1&b=2");
	});

	// Test for figure with HTML entities
	it("decodes HTML entities in figure images", () => {
		const html = `<figure><img src="https://example.com/photo.jpg?w=200&#038;h=300" alt="test"><figcaption>Caption</figcaption></figure>`;
		const result = htmlToPortableText(html);

		const img = result[0] as PortableTextImageBlock;
		expect(img._type).toBe("image");
		expect(img.asset.url).toBe("https://example.com/photo.jpg?w=200&h=300");
		expect(img.caption).toBe("Caption");
	});
});

describe("parseGutenbergBlocks", () => {
	it("parses blocks without converting", () => {
		const content = `<!-- wp:paragraph -->
<p>Hello</p>
<!-- /wp:paragraph -->`;

		const blocks = parseGutenbergBlocks(content);

		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.blockName).toBe("core/paragraph");
		expect(blocks[0]?.innerHTML).toContain("Hello");
	});

	it("returns empty array for empty content", () => {
		expect(parseGutenbergBlocks("")).toEqual([]);
	});

	it("preserves block attributes", () => {
		const content = `<!-- wp:heading {"level":3,"align":"center"} -->
<h3>Title</h3>
<!-- /wp:heading -->`;

		const blocks = parseGutenbergBlocks(content);

		expect(blocks[0]?.attrs).toMatchObject({
			level: 3,
			align: "center",
		});
	});

	it("handles nested blocks", () => {
		const content = `<!-- wp:columns -->
<div>
<!-- wp:column -->
<div>
<!-- wp:paragraph -->
<p>Nested</p>
<!-- /wp:paragraph -->
</div>
<!-- /wp:column -->
</div>
<!-- /wp:columns -->`;

		const blocks = parseGutenbergBlocks(content);

		expect(blocks[0]?.blockName).toBe("core/columns");
		expect(blocks[0]?.innerBlocks.length).toBeGreaterThan(0);
	});
});
