/**
 * Tests for the Contentful Rich Text → Portable Text converter.
 * One test per acceptance criterion from the PR plan.
 */

import type { Document } from "@contentful/rich-text-types";
import type { PortableTextSpan, PortableTextMarkDefinition } from "@portabletext/types";
import { describe, it, expect, vi } from "vitest";

import { richTextToPortableText, buildIncludes } from "../src/index.js";
import type { ContentfulIncludes } from "../src/index.js";
import fixture from "./fixtures/contentful-blogpost.json";

// ── Test helpers ────────────────────────────────────────────────────────────
// Test helpers use `any` for fixture construction — we're testing runtime
// behavior of the converter, not type-safety of the test inputs.

function buildFixtureIncludes(): ContentfulIncludes {
	return buildIncludes({
		Entry: fixture.items as Array<Record<string, unknown>>,
		Asset: (fixture.includes?.Asset ?? []) as Array<Record<string, unknown>>,
	});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convert(doc: Document, includes?: ContentfulIncludes, options?: any): any[] {
	return richTextToPortableText(doc, includes ?? emptyIncludes(), options ?? {});
}

function emptyIncludes(): ContentfulIncludes {
	return { entries: new Map(), assets: new Map() };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDoc(...nodes: any[]): Document {
	return { nodeType: "document", content: nodes, data: {} } as Document;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function text(value: string, marks: Array<{ type: string }> = []): any {
	return { nodeType: "text", value, marks, data: {} };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function paragraph(...children: any[]): any {
	return { nodeType: "paragraph", content: children, data: {} };
}

// Get the two blog posts from the fixture
const post0 = fixture.items[0]!; // Deep Dive
const post1 = fixture.items[1]!; // Lessons

// ── Standard blocks ─────────────────────────────────────────────────────────

describe("Standard blocks", () => {
	it("paragraph → block with style normal", () => {
		const doc = makeDoc(paragraph(text("Hello world")));
		const blocks = convert(doc);

		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			_type: "block",
			style: "normal",
		});
		const children = blocks[0]!.children as PortableTextSpan[];
		expect(children[0]!.text).toBe("Hello world");
	});

	it("heading-1 through heading-6 → block with style h1–h6", () => {
		for (let i = 1; i <= 6; i++) {
			const doc = makeDoc({
				nodeType: `heading-${i}`,
				content: [text(`Heading ${i}`)],
				data: {},
			});
			const blocks = convert(doc);
			expect(blocks).toHaveLength(1);
			expect(blocks[0]).toMatchObject({
				_type: "block",
				style: `h${i}`,
			});
		}
	});

	it("heading-2 from fixture → block with style h2", () => {
		const includes = buildFixtureIncludes();
		const doc = post0.fields.content as unknown as Document;
		const blocks = richTextToPortableText(doc, includes);

		const h2 = blocks[0]!;
		expect(h2).toMatchObject({ _type: "block", style: "h2" });
		expect((h2.children as PortableTextSpan[])[0]!.text).toBe("Why Migration Matters");
	});

	it("unordered-list with 3+ items → bullet list blocks", () => {
		const includes = buildFixtureIncludes();
		const doc = post0.fields.content as unknown as Document;
		const blocks = richTextToPortableText(doc, includes);

		// Find bullet list items
		const bullets = blocks.filter((b) => b.listItem === "bullet");
		expect(bullets.length).toBeGreaterThanOrEqual(3);

		for (const bullet of bullets) {
			expect(bullet).toMatchObject({
				_type: "block",
				listItem: "bullet",
				level: 1,
			});
		}

		// Verify texts
		const bulletTexts = bullets.map(
			(b) => ((b.children as PortableTextSpan[])[0] as PortableTextSpan).text,
		);
		expect(bulletTexts).toEqual(
			expect.arrayContaining([
				"Parse the source format",
				"Transform to target schema",
				"Validate the output",
			]),
		);
	});

	it("ordered-list with 3+ items → numbered list blocks", () => {
		const includes = buildFixtureIncludes();
		const doc = post0.fields.content as unknown as Document;
		const blocks = richTextToPortableText(doc, includes);

		const numbered = blocks.filter((b) => b.listItem === "number");
		expect(numbered.length).toBeGreaterThanOrEqual(3);

		for (const item of numbered) {
			expect(item).toMatchObject({
				_type: "block",
				listItem: "number",
				level: 1,
			});
		}
	});

	it("nested list (bullet inside numbered) → inner items have level 2", () => {
		const doc = makeDoc({
			nodeType: "ordered-list",
			data: {},
			content: [
				{
					nodeType: "list-item",
					data: {},
					content: [
						paragraph(text("Top level")),
						{
							nodeType: "unordered-list",
							data: {},
							content: [
								{
									nodeType: "list-item",
									data: {},
									content: [paragraph(text("Nested"))],
								},
							],
						},
					],
				},
			],
		});

		const blocks = convert(doc);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toMatchObject({
			listItem: "number",
			level: 1,
		});
		expect(blocks[1]).toMatchObject({
			listItem: "bullet",
			level: 2,
		});
	});

	it("blockquote containing paragraphs → blocks with style blockquote", () => {
		const includes = buildFixtureIncludes();
		const doc = post0.fields.content as unknown as Document;
		const blocks = richTextToPortableText(doc, includes);

		const quotes = blocks.filter((b) => b.style === "blockquote");
		expect(quotes.length).toBeGreaterThanOrEqual(1);
		expect(quotes[0]).toMatchObject({
			_type: "block",
			style: "blockquote",
		});
	});

	it("blockquote with 2 paragraphs → 2 blocks with style blockquote", () => {
		const doc = makeDoc({
			nodeType: "blockquote",
			data: {},
			content: [paragraph(text("First paragraph")), paragraph(text("Second paragraph"))],
		});
		const blocks = convert(doc);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toMatchObject({ style: "blockquote" });
		expect(blocks[1]).toMatchObject({ style: "blockquote" });
	});

	it("hr → break with style lineBreak", () => {
		const doc = makeDoc({ nodeType: "hr", data: {} });
		const blocks = convert(doc);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			_type: "break",
			style: "lineBreak",
		});
	});

	it("table with header + 2 rows → table block with rows and cells", () => {
		const doc = makeDoc({
			nodeType: "table",
			data: {},
			content: [
				{
					nodeType: "table-row",
					data: {},
					content: [
						{
							nodeType: "table-header-cell",
							data: {},
							content: [paragraph(text("Name"))],
						},
						{
							nodeType: "table-header-cell",
							data: {},
							content: [paragraph(text("Value"))],
						},
					],
				},
				{
					nodeType: "table-row",
					data: {},
					content: [
						{
							nodeType: "table-cell",
							data: {},
							content: [paragraph(text("A"))],
						},
						{
							nodeType: "table-cell",
							data: {},
							content: [paragraph(text("1"))],
						},
					],
				},
				{
					nodeType: "table-row",
					data: {},
					content: [
						{
							nodeType: "table-cell",
							data: {},
							content: [paragraph(text("B"))],
						},
						{
							nodeType: "table-cell",
							data: {},
							content: [paragraph(text("2"))],
						},
					],
				},
			],
		});

		const blocks = convert(doc);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!._type).toBe("table");
		const rows = blocks[0]!.rows as Array<{
			_type: string;
			cells: string[];
		}>;
		expect(rows).toHaveLength(3);
		expect(rows[0]!.cells).toEqual(["Name", "Value"]);
		expect(rows[1]!.cells).toEqual(["A", "1"]);
		expect(rows[2]!.cells).toEqual(["B", "2"]);
	});

	it("table cell containing a hyperlink → link text preserved", () => {
		const doc = makeDoc({
			nodeType: "table",
			data: {},
			content: [
				{
					nodeType: "table-row",
					data: {},
					content: [
						{
							nodeType: "table-cell",
							data: {},
							content: [
								{
									nodeType: "paragraph",
									data: {},
									content: [
										text("See "),
										{
											nodeType: "hyperlink",
											data: {
												uri: "https://example.com",
											},
											content: [text("this link")],
										},
										text(" here"),
									],
								},
							],
						},
					],
				},
			],
		});

		const blocks = convert(doc);
		const rows = blocks[0]!.rows as Array<{ cells: string[] }>;
		expect(rows[0]!.cells[0]).toBe("See this link here");
	});

	it("empty paragraph → filtered out", () => {
		const doc = makeDoc(paragraph(text("")));
		const blocks = convert(doc);
		expect(blocks).toHaveLength(0);
	});
});

// ── Inline marks ────────────────────────────────────────────────────────────

describe("Inline marks", () => {
	it("bold → marks: ['strong']", () => {
		const doc = makeDoc(paragraph(text("bold text", [{ type: "bold" }])));
		const blocks = convert(doc);
		const span = (blocks[0]!.children as PortableTextSpan[])[0]!;
		expect(span.marks).toEqual(["strong"]);
	});

	it("italic → marks: ['em']", () => {
		const doc = makeDoc(paragraph(text("italic text", [{ type: "italic" }])));
		const blocks = convert(doc);
		const span = (blocks[0]!.children as PortableTextSpan[])[0]!;
		expect(span.marks).toEqual(["em"]);
	});

	it("code → marks: ['code']", () => {
		const doc = makeDoc(paragraph(text("code text", [{ type: "code" }])));
		const blocks = convert(doc);
		const span = (blocks[0]!.children as PortableTextSpan[])[0]!;
		expect(span.marks).toEqual(["code"]);
	});

	it("underline → marks: ['underline']", () => {
		const doc = makeDoc(paragraph(text("underlined", [{ type: "underline" }])));
		const blocks = convert(doc);
		const span = (blocks[0]!.children as PortableTextSpan[])[0]!;
		expect(span.marks).toEqual(["underline"]);
	});

	it("superscript → marks: ['sup']", () => {
		const doc = makeDoc(paragraph(text("sup", [{ type: "superscript" }])));
		const blocks = convert(doc);
		const span = (blocks[0]!.children as PortableTextSpan[])[0]!;
		expect(span.marks).toEqual(["sup"]);
	});

	it("subscript → marks: ['sub']", () => {
		const doc = makeDoc(paragraph(text("sub", [{ type: "subscript" }])));
		const blocks = convert(doc);
		const span = (blocks[0]!.children as PortableTextSpan[])[0]!;
		expect(span.marks).toEqual(["sub"]);
	});

	it("combined marks (bold + italic + code) → marks: ['strong', 'em', 'code']", () => {
		const doc = makeDoc(
			paragraph(text("all marks", [{ type: "bold" }, { type: "italic" }, { type: "code" }])),
		);
		const blocks = convert(doc);
		const span = (blocks[0]!.children as PortableTextSpan[])[0]!;
		expect(span.marks).toEqual(["strong", "em", "code"]);
	});

	it("italic + bold + code from fixture", () => {
		const includes = buildFixtureIncludes();
		const doc = post0.fields.content as unknown as Document;
		const blocks = richTextToPortableText(doc, includes);

		// Second block is the paragraph with "Building a migration pipeline..."
		const para = blocks[1]!;
		expect(para._type).toBe("block");
		const children = para.children as PortableTextSpan[];

		// "every content format" has italic + bold
		const boldItalic = children.find((c) => c.text === "every content format");
		expect(boldItalic).toBeDefined();
		expect(boldItalic!.marks).toEqual(expect.arrayContaining(["em", "strong"]));

		// "code snippets" has italic + code
		const codeItalic = children.find((c) => c.text === "code snippets");
		expect(codeItalic).toBeDefined();
		expect(codeItalic!.marks).toEqual(expect.arrayContaining(["em", "code"]));
	});
});

// ── Hyperlinks ──────────────────────────────────────────────────────────────

describe("Hyperlinks", () => {
	it("hyperlink with external URL → markDef with blank: true", () => {
		const includes = buildFixtureIncludes();
		const doc = post0.fields.content as unknown as Document;
		const blocks = richTextToPortableText(doc, includes);

		// Find the paragraph with the "Workers documentation" hyperlink
		const linkBlock = blocks.find((b) => {
			const children = b.children as PortableTextSpan[] | undefined;
			return children?.some((c) => c.text === "Workers documentation");
		});
		expect(linkBlock).toBeDefined();

		const markDefs = linkBlock!.markDefs as PortableTextMarkDefinition[];
		const linkMark = markDefs.find((m) => m._type === "link");
		expect(linkMark).toBeDefined();
		expect(linkMark!.href).toBe("https://developers.cloudflare.com/workers/");
		expect(linkMark!.blank).toBe(true);
	});

	it("hyperlink with internal URL → markDef without blank", () => {
		const doc = makeDoc({
			nodeType: "paragraph",
			data: {},
			content: [
				{
					nodeType: "hyperlink",
					data: { uri: "https://myblog.com/post" },
					content: [text("link")],
				},
			],
		});
		const blocks = convert(doc, emptyIncludes(), {
			blogHostname: "myblog.com",
		});

		const markDefs = blocks[0]!.markDefs as PortableTextMarkDefinition[];
		expect(markDefs[0]).toMatchObject({
			_type: "link",
			href: "https://myblog.com/post",
		});
		expect(markDefs[0]!.blank).toBeUndefined();
	});

	it("hyperlink with javascript: URI → sanitized to href: '#'", () => {
		const doc = makeDoc({
			nodeType: "paragraph",
			data: {},
			content: [
				{
					nodeType: "hyperlink",
					data: { uri: "javascript:alert(1)" },
					content: [text("evil link")],
				},
			],
		});
		const blocks = convert(doc);

		const markDefs = blocks[0]!.markDefs as PortableTextMarkDefinition[];
		expect(markDefs[0]!.href).toBe("#");
	});

	it("hyperlink with mixed-case JaVaScRiPt: URI → sanitized to href: '#'", () => {
		const doc = makeDoc({
			nodeType: "paragraph",
			data: {},
			content: [
				{
					nodeType: "hyperlink",
					data: { uri: " JaVaScRiPt:alert(1)" },
					content: [text("evil link")],
				},
			],
		});
		const blocks = convert(doc);

		const markDefs = blocks[0]!.markDefs as PortableTextMarkDefinition[];
		expect(markDefs[0]!.href).toBe("#");
	});

	it("entry-hyperlink → resolved to /slug/ from includes", () => {
		const includes = emptyIncludes();
		includes.entries.set("entry-123", {
			id: "entry-123",
			contentType: "blogPost",
			fields: { slug: "my-post", title: "My Post" },
		});

		const doc = makeDoc({
			nodeType: "paragraph",
			data: {},
			content: [
				{
					nodeType: "entry-hyperlink",
					data: { target: { sys: { id: "entry-123" } } },
					content: [text("click here")],
				},
			],
		});

		const blocks = convert(doc, includes);
		const markDefs = blocks[0]!.markDefs as PortableTextMarkDefinition[];
		expect(markDefs[0]!.href).toBe("/my-post/");
	});

	it("entryHrefResolver output is sanitized against javascript: injection", () => {
		const includes = emptyIncludes();
		includes.entries.set("entry-xss", {
			id: "entry-xss",
			contentType: "blogPost",
			fields: { slug: "xss-post", title: "XSS Post" },
		});

		const doc = makeDoc({
			nodeType: "paragraph",
			data: {},
			content: [
				{
					nodeType: "entry-hyperlink",
					data: { target: { sys: { id: "entry-xss" } } },
					content: [text("click me")],
				},
			],
		});

		const blocks = richTextToPortableText(doc, includes, {
			entryHrefResolver: () => "javascript:alert(1)",
		});
		const markDefs = blocks[0]!.markDefs as PortableTextMarkDefinition[];
		expect(markDefs[0]!.href).toBe("#");
	});

	it("entryHrefResolver customizes entry-hyperlink URL shape", () => {
		const includes = emptyIncludes();
		includes.entries.set("product-1", {
			id: "product-1",
			contentType: "product",
			fields: { slug: "widget", handle: "widget-pro" },
		});

		const doc = makeDoc({
			nodeType: "paragraph",
			data: {},
			content: [
				{
					nodeType: "entry-hyperlink",
					data: { target: { sys: { id: "product-1" } } },
					content: [text("buy now")],
				},
			],
		});

		const blocks = richTextToPortableText(doc, includes, {
			entryHrefResolver: (entry) => `/products/${entry.fields.slug as string}/`,
		});
		const markDefs = blocks[0]!.markDefs as PortableTextMarkDefinition[];
		expect(markDefs[0]!.href).toBe("/products/widget/");
	});

	it("asset-hyperlink → resolved to asset URL from includes", () => {
		const includes = emptyIncludes();
		includes.assets.set("asset-456", {
			id: "asset-456",
			url: "https://cdn.example.com/file.pdf",
			title: "My PDF",
		});

		const doc = makeDoc({
			nodeType: "paragraph",
			data: {},
			content: [
				{
					nodeType: "asset-hyperlink",
					data: { target: { sys: { id: "asset-456" } } },
					content: [text("download")],
				},
			],
		});

		const blocks = convert(doc, includes);
		const markDefs = blocks[0]!.markDefs as PortableTextMarkDefinition[];
		expect(markDefs[0]!.href).toBe("https://cdn.example.com/file.pdf");
	});

	it("hyperlink with no resolvable target → href: '#'", () => {
		const doc = makeDoc({
			nodeType: "paragraph",
			data: {},
			content: [
				{
					nodeType: "entry-hyperlink",
					data: { target: { sys: { id: "nonexistent" } } },
					content: [text("broken link")],
				},
			],
		});

		const blocks = convert(doc);
		const markDefs = blocks[0]!.markDefs as PortableTextMarkDefinition[];
		expect(markDefs[0]!.href).toBe("#");
	});

	it("hyperlink span references the markDef key", () => {
		const doc = makeDoc({
			nodeType: "paragraph",
			data: {},
			content: [
				{
					nodeType: "hyperlink",
					data: { uri: "https://example.com" },
					content: [text("link text")],
				},
			],
		});

		const blocks = convert(doc);
		const markDefs = blocks[0]!.markDefs as PortableTextMarkDefinition[];
		const children = blocks[0]!.children as PortableTextSpan[];
		const linkSpan = children.find((c) => c.text === "link text");
		expect(linkSpan!.marks).toContain(markDefs[0]!._key);
	});
});

// ── Embedded entries ────────────────────────────────────────────────────────

describe("Embedded entries", () => {
	it("blogCodeBlock → codeBlock with code and language", () => {
		const includes = emptyIncludes();
		includes.entries.set("code-1", {
			id: "code-1",
			contentType: "blogCodeBlock",
			fields: {
				code: 'console.log("hello")',
				language: "javascript",
			},
		});

		const doc = makeDoc({
			nodeType: "embedded-entry-block",
			data: { target: { sys: { id: "code-1" } } },
		});

		const blocks = convert(doc, includes);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			_type: "code",
			code: 'console.log("hello")',
			language: "javascript",
		});
	});

	it("blogCodeBlock with missing language → language: ''", () => {
		const includes = emptyIncludes();
		includes.entries.set("code-2", {
			id: "code-2",
			contentType: "blogCodeBlock",
			fields: { code: "some code" },
		});

		const doc = makeDoc({
			nodeType: "embedded-entry-block",
			data: { target: { sys: { id: "code-2" } } },
		});

		const blocks = convert(doc, includes);
		expect(blocks[0]!.language).toBe("");
	});

	it("blogEmbeddedHtml → htmlBlock with html preserved verbatim", () => {
		const html = '<div style="padding:1.5rem"><strong>Note:</strong> test</div>';
		const includes = emptyIncludes();
		includes.entries.set("html-1", {
			id: "html-1",
			contentType: "blogEmbeddedHtml",
			fields: { customHtml: html },
		});

		const doc = makeDoc({
			nodeType: "embedded-entry-block",
			data: { target: { sys: { id: "html-1" } } },
		});

		const blocks = convert(doc, includes);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			_type: "htmlBlock",
			html,
		});
	});

	it("HTML is preserved verbatim (no sanitization, no escaping)", () => {
		const includes = buildFixtureIncludes();
		const doc = post0.fields.content as unknown as Document;
		const blocks = richTextToPortableText(doc, includes);

		const htmlBlock = blocks.find((b) => b._type === "htmlBlock");
		expect(htmlBlock).toBeDefined();
		// The fixture's blogEmbeddedHtml has actual HTML with tags and attributes
		expect((htmlBlock as any).html as string).toContain("<div");
		expect((htmlBlock as any).html as string).toContain("style=");
		expect((htmlBlock as any).html as string).toContain("<strong>");
	});

	it("blogImage → imageBlock with asset src, alt, width, height", () => {
		const includes = buildFixtureIncludes();
		const doc = post1.fields.content as unknown as Document;
		const blocks = richTextToPortableText(doc, includes);

		const imageBlock = blocks.find((b) => b._type === "image");
		expect(imageBlock).toBeDefined();

		const asset = (imageBlock as any).asset as {
			src: string;
			alt: string;
			width?: number;
			height?: number;
		};
		expect(asset.src).toContain("images.ctfassets.net");
		expect(asset.src).toMatch(/^https:/);
		expect(typeof asset.width).toBe("number");
		expect(typeof asset.height).toBe("number");
	});

	it("blogImage asset URL starting with // → prefixed with https:", () => {
		const includes = emptyIncludes();
		includes.entries.set("img-1", {
			id: "img-1",
			contentType: "blogImage",
			fields: {
				assetFile: { sys: { id: "asset-proto" } },
			},
		});
		includes.assets.set("asset-proto", {
			id: "asset-proto",
			url: "//images.ctfassets.net/test.png",
			title: "test",
			width: 100,
			height: 100,
		});

		const doc = makeDoc({
			nodeType: "embedded-entry-block",
			data: { target: { sys: { id: "img-1" } } },
		});

		const blocks = convert(doc, includes);
		const asset = blocks[0]!.asset as { src: string };
		expect(asset.src).toBe("https://images.ctfassets.net/test.png");
	});

	it("blogImage with size: 'Wide' → size preserved", () => {
		const includes = emptyIncludes();
		includes.entries.set("img-wide", {
			id: "img-wide",
			contentType: "blogImage",
			fields: {
				assetFile: { sys: { id: "asset-w" } },
				size: "Wide",
			},
		});
		includes.assets.set("asset-w", {
			id: "asset-w",
			url: "https://cdn.example.com/wide.png",
			width: 1200,
			height: 600,
		});

		const doc = makeDoc({
			nodeType: "embedded-entry-block",
			data: { target: { sys: { id: "img-wide" } } },
		});

		const blocks = convert(doc, includes);
		expect(blocks[0]!.size).toBe("Wide");
	});

	it("blogImage with linkUrl → linkUrl preserved", () => {
		const includes = emptyIncludes();
		includes.entries.set("img-link", {
			id: "img-link",
			contentType: "blogImage",
			fields: {
				assetFile: { sys: { id: "asset-l" } },
				linkUrl: "https://example.com/target",
			},
		});
		includes.assets.set("asset-l", {
			id: "asset-l",
			url: "https://cdn.example.com/linked.png",
			width: 800,
			height: 400,
		});

		const doc = makeDoc({
			nodeType: "embedded-entry-block",
			data: { target: { sys: { id: "img-link" } } },
		});

		const blocks = convert(doc, includes);
		expect(blocks[0]!.linkUrl).toBe("https://example.com/target");
	});

	it("blogImage with javascript: linkUrl → linkUrl sanitized to '#'", () => {
		const includes = emptyIncludes();
		includes.entries.set("img-xss", {
			id: "img-xss",
			contentType: "blogImage",
			fields: {
				assetFile: { sys: { id: "asset-x" } },
				linkUrl: "javascript:alert(2)",
			},
		});
		includes.assets.set("asset-x", {
			id: "asset-x",
			url: "https://cdn.example.com/img.png",
			width: 100,
			height: 100,
		});

		const doc = makeDoc({
			nodeType: "embedded-entry-block",
			data: { target: { sys: { id: "img-xss" } } },
		});

		const blocks = convert(doc, includes);
		expect(blocks[0]!.linkUrl).toBe("#");
	});

	it("unknown content type → null, console warning", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const includes = emptyIncludes();
		includes.entries.set("unknown-1", {
			id: "unknown-1",
			contentType: "blogWidget",
			fields: {},
		});

		const doc = makeDoc({
			nodeType: "embedded-entry-block",
			data: { target: { sys: { id: "unknown-1" } } },
		});

		const blocks = convert(doc, includes);
		expect(blocks).toHaveLength(0);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Unknown embedded entry type: blogWidget"),
		);
		warnSpy.mockRestore();
	});

	it("unresolved entry → null, console warning", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const doc = makeDoc({
			nodeType: "embedded-entry-block",
			data: { target: { sys: { id: "nonexistent-id" } } },
		});

		const blocks = convert(doc);
		expect(blocks).toHaveLength(0);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unresolved embedded entry"));
		warnSpy.mockRestore();
	});
});

// ── Embedded assets (legacy) ────────────────────────────────────────────────

describe("Embedded assets (legacy)", () => {
	it("embedded-asset-block → imageBlock with src, alt, width, height", () => {
		const includes = buildFixtureIncludes();
		const doc = post1.fields.content as unknown as Document;
		const blocks = richTextToPortableText(doc, includes);

		// Post 1 has an embedded-asset-block referencing asset-1
		const imageBlocks = blocks.filter((b) => b._type === "image");
		expect(imageBlocks.length).toBeGreaterThanOrEqual(1);

		// The legacy embedded asset image should have the architecture-diagram asset
		const legacyImage = imageBlocks.find((b) => {
			const asset = (b as any).asset as { src: string };
			return asset.src.includes("architecture-diagram");
		});
		expect(legacyImage).toBeDefined();

		const asset = (legacyImage as any).asset as {
			src: string;
			alt: string;
			width: number;
			height: number;
		};
		expect(asset.src).toMatch(/^https:/);
		expect(asset.alt).toBe("A diagram showing the migration pipeline architecture");
		expect(asset.width).toBe(1200);
		expect(asset.height).toBe(800);
	});

	it("asset URL starting with // → prefixed with https:", () => {
		const includes = emptyIncludes();
		includes.assets.set("proto-asset", {
			id: "proto-asset",
			url: "//images.ctfassets.net/legacy.png",
			title: "Legacy",
			width: 640,
			height: 480,
		});

		const doc = makeDoc({
			nodeType: "embedded-asset-block",
			data: { target: { sys: { id: "proto-asset" } } },
		});

		const blocks = convert(doc, includes);
		expect(blocks).toHaveLength(1);
		const asset = blocks[0]!.asset as { src: string };
		expect(asset.src).toBe("https://images.ctfassets.net/legacy.png");
	});

	it("unresolved asset → null, console warning", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const doc = makeDoc({
			nodeType: "embedded-asset-block",
			data: { target: { sys: { id: "missing-asset" } } },
		});

		const blocks = convert(doc);
		expect(blocks).toHaveLength(0);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unresolved embedded asset"));
		warnSpy.mockRestore();
	});
});

// ── Integration ─────────────────────────────────────────────────────────────

describe("Integration", () => {
	it("full document (post 0) with all block types → valid PT array, no crashes", () => {
		const includes = buildFixtureIncludes();
		const doc = post0.fields.content as unknown as Document;
		const blocks = richTextToPortableText(doc, includes);

		expect(blocks.length).toBeGreaterThan(5);
		expect(blocks.every((b) => b._type !== undefined)).toBe(true);
		expect(blocks.every((b) => b._key !== undefined)).toBe(true);

		// Should contain headings, paragraphs, lists, blockquotes, embedded entries
		const types = new Set(blocks.map((b) => b._type));
		expect(types.has("block")).toBe(true);

		// Should have embedded code and html blocks
		const allTypes = blocks.map((b) => b._type);
		expect(allTypes).toContain("code");
		expect(allTypes).toContain("htmlBlock");
	});

	it("full document (post 1) with embedded entries and assets → valid PT", () => {
		const includes = buildFixtureIncludes();
		const doc = post1.fields.content as unknown as Document;
		const blocks = richTextToPortableText(doc, includes);

		expect(blocks.length).toBeGreaterThan(5);

		const types = new Set(blocks.map((b) => b._type));
		expect(types.has("block")).toBe(true);
		expect(types.has("htmlBlock")).toBe(true);
		expect(types.has("image")).toBe(true);
	});

	it("output is JSON-serializable (round-trips without loss)", () => {
		const includes = buildFixtureIncludes();
		const doc = post0.fields.content as unknown as Document;
		const blocks = richTextToPortableText(doc, includes);

		const json = JSON.stringify(blocks);
		const parsed = JSON.parse(json);
		expect(parsed).toEqual(blocks);
	});

	it("separate calls produce identical keys (call-scoped counters)", () => {
		const includes = buildFixtureIncludes();
		const doc = post0.fields.content as unknown as Document;

		const blocks1 = richTextToPortableText(doc, includes);
		const blocks2 = richTextToPortableText(doc, includes);

		expect(blocks1.map((b) => b._key)).toEqual(blocks2.map((b) => b._key));
	});
});

// ── Edge cases and regression tests ─────────────────────────────────────────

describe("Edge cases", () => {
	it("blockquote containing a list preserves the list", () => {
		const doc = makeDoc({
			nodeType: "blockquote",
			data: {},
			content: [
				paragraph(text("quoted text")),
				{
					nodeType: "unordered-list",
					data: {},
					content: [
						{
							nodeType: "list-item",
							data: {},
							content: [paragraph(text("bullet point"))],
						},
					],
				},
			],
		});

		const blocks = convert(doc);
		expect(blocks.length).toBeGreaterThanOrEqual(2);
		const listBlock = blocks.find((b) => b.listItem === "bullet");
		expect(listBlock).toBeDefined();
		expect((listBlock!.children as PortableTextSpan[])[0]!.text).toBe("bullet point");
	});

	it("list item containing an embedded entry preserves it", () => {
		const includes = emptyIncludes();
		includes.entries.set("code-1", {
			id: "code-1",
			contentType: "blogCodeBlock",
			fields: { code: "console.log('hi')", language: "javascript" },
		});

		const doc = makeDoc({
			nodeType: "ordered-list",
			data: {},
			content: [
				{
					nodeType: "list-item",
					data: {},
					content: [
						paragraph(text("step one")),
						{
							nodeType: "embedded-entry-block",
							data: { target: { sys: { id: "code-1" } } },
							content: [],
						},
					],
				},
			],
		});

		const blocks = convert(doc, includes);
		const codeBlock = blocks.find((b) => b._type === "code");
		expect(codeBlock).toBeDefined();
		expect(codeBlock!.code).toBe("console.log('hi')");
	});

	it("buildIncludes skips entries with missing sys.id", () => {
		const includes = buildIncludes({
			Entry: [
				{ sys: { id: "valid-1", contentType: { sys: { id: "post" } } }, fields: { title: "ok" } },
				{ sys: {}, fields: { title: "no id" } },
				{ fields: { title: "no sys" } },
			],
			Asset: [
				{ sys: { id: "asset-1" }, fields: { file: { url: "https://x.com/a.jpg" } } },
				{ sys: {}, fields: {} },
			],
		});

		expect(includes.entries.size).toBe(1);
		expect(includes.entries.get("valid-1")).toBeDefined();
		expect(includes.assets.size).toBe(1);
		expect(includes.assets.get("asset-1")).toBeDefined();
	});

	it("resource-hyperlink preserves visible text", () => {
		const doc = makeDoc({
			nodeType: "paragraph",
			data: {},
			content: [
				{
					nodeType: "resource-hyperlink",
					data: { target: { sys: { urn: "crn:contentful:some-resource" } } },
					content: [text("linked text")],
				},
			],
		});

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const blocks = convert(doc);
		warnSpy.mockRestore();

		const spans = blocks[0]!.children as PortableTextSpan[];
		const linkedSpan = spans.find((s) => s.text === "linked text");
		expect(linkedSpan).toBeDefined();
	});

	it("entryHrefResolver receives entry even without slug field", () => {
		const includes = emptyIncludes();
		includes.entries.set("product-1", {
			id: "product-1",
			contentType: "product",
			fields: { handle: "widget-pro" },
		});

		const doc = makeDoc({
			nodeType: "paragraph",
			data: {},
			content: [
				{
					nodeType: "entry-hyperlink",
					data: { target: { sys: { id: "product-1" } } },
					content: [text("buy now")],
				},
			],
		});

		const blocks = richTextToPortableText(doc, includes, {
			entryHrefResolver: (entry) => `/products/${entry.fields.handle as string}/`,
		});
		const markDefs = blocks[0]!.markDefs as PortableTextMarkDefinition[];
		expect(markDefs[0]!.href).toBe("/products/widget-pro/");
	});

	it("entry-hyperlink without slug and no resolver falls back to #", () => {
		const includes = emptyIncludes();
		includes.entries.set("no-slug", {
			id: "no-slug",
			contentType: "product",
			fields: { handle: "widget" },
		});

		const doc = makeDoc({
			nodeType: "paragraph",
			data: {},
			content: [
				{
					nodeType: "entry-hyperlink",
					data: { target: { sys: { id: "no-slug" } } },
					content: [text("link")],
				},
			],
		});

		const blocks = convert(doc, includes);
		const markDefs = blocks[0]!.markDefs as PortableTextMarkDefinition[];
		expect(markDefs[0]!.href).toBe("#");
	});
});
