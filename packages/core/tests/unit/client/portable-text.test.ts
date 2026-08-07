import { describe, it, expect, beforeEach } from "vitest";

import type { PortableTextBlock, FieldSchema } from "../../../src/client/portable-text.js";
import {
	portableTextToMarkdown,
	markdownToPortableText,
	resetKeyCounter,
	convertDataForRead,
	convertDataForWrite,
} from "../../../src/client/portable-text.js";

beforeEach(() => {
	resetKeyCounter();
});

// ---------------------------------------------------------------------------
// PT -> Markdown
// ---------------------------------------------------------------------------

describe("portableTextToMarkdown", () => {
	it("converts a simple paragraph", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "block",
				_key: "a",
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", _key: "s1", text: "Hello world", marks: [] }],
			},
		];
		expect(portableTextToMarkdown(blocks)).toBe("Hello world\n");
	});

	it("converts headings h1-h6", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "block",
				style: "h1",
				markDefs: [],
				children: [{ _type: "span", text: "Title", marks: [] }],
			},
			{
				_type: "block",
				style: "h3",
				markDefs: [],
				children: [{ _type: "span", text: "Subtitle", marks: [] }],
			},
		];
		expect(portableTextToMarkdown(blocks)).toBe("# Title\n\n### Subtitle\n");
	});

	it("converts bold, italic, code, and strikethrough marks", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "block",
				style: "normal",
				markDefs: [],
				children: [
					{ _type: "span", text: "bold", marks: ["strong"] },
					{ _type: "span", text: " and ", marks: [] },
					{ _type: "span", text: "italic", marks: ["em"] },
					{ _type: "span", text: " and ", marks: [] },
					{ _type: "span", text: "code", marks: ["code"] },
					{ _type: "span", text: " and ", marks: [] },
					{ _type: "span", text: "struck", marks: ["strike-through"] },
				],
			},
		];
		expect(portableTextToMarkdown(blocks)).toBe(
			"**bold** and _italic_ and `code` and ~~struck~~\n",
		);
	});

	it("converts links via markDefs", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "block",
				style: "normal",
				markDefs: [{ _key: "link1", _type: "link", href: "https://example.com" }],
				children: [
					{ _type: "span", text: "Click ", marks: [] },
					{ _type: "span", text: "here", marks: ["link1"] },
				],
			},
		];
		expect(portableTextToMarkdown(blocks)).toBe("Click [here](https://example.com)\n");
	});

	it("converts blockquotes", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "block",
				style: "blockquote",
				markDefs: [],
				children: [{ _type: "span", text: "A quote", marks: [] }],
			},
		];
		expect(portableTextToMarkdown(blocks)).toBe("> A quote\n");
	});

	it("converts unordered lists", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "block",
				style: "normal",
				listItem: "bullet",
				level: 1,
				markDefs: [],
				children: [{ _type: "span", text: "First", marks: [] }],
			},
			{
				_type: "block",
				style: "normal",
				listItem: "bullet",
				level: 1,
				markDefs: [],
				children: [{ _type: "span", text: "Second", marks: [] }],
			},
			{
				_type: "block",
				style: "normal",
				listItem: "bullet",
				level: 2,
				markDefs: [],
				children: [{ _type: "span", text: "Nested", marks: [] }],
			},
		];
		expect(portableTextToMarkdown(blocks)).toBe("- First\n- Second\n  - Nested\n");
	});

	it("converts ordered lists", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "block",
				style: "normal",
				listItem: "number",
				level: 1,
				markDefs: [],
				children: [{ _type: "span", text: "First", marks: [] }],
			},
			{
				_type: "block",
				style: "normal",
				listItem: "number",
				level: 1,
				markDefs: [],
				children: [{ _type: "span", text: "Second", marks: [] }],
			},
		];
		expect(portableTextToMarkdown(blocks)).toBe("1. First\n1. Second\n");
	});

	it("does not synthesize continuity metadata across a lossy Markdown boundary", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "block",
				listItem: "number",
				level: 1,
				listId: "first",
				listStart: 1,
				children: [{ _type: "span", text: "One" }],
			},
			{
				_type: "block",
				listItem: "number",
				level: 2,
				listId: "nested",
				listStart: 1,
				children: [{ _type: "span", text: "Nested" }],
			},
			{
				_type: "block",
				listItem: "number",
				level: 1,
				listId: "second",
				listStart: 1,
				children: [{ _type: "span", text: "Other" }],
			},
		];
		const imported = markdownToPortableText(portableTextToMarkdown(blocks));

		expect(imported.map((block) => [block.listId, block.listStart])).toEqual([
			[undefined, undefined],
			[undefined, undefined],
			[undefined, undefined],
		]);
	});

	it("converts code blocks", () => {
		const blocks: PortableTextBlock[] = [
			{ _type: "code", _key: "c1", language: "typescript", code: "const x = 1;\nconsole.log(x);" },
		];
		expect(portableTextToMarkdown(blocks)).toBe(
			"```typescript\nconst x = 1;\nconsole.log(x);\n```\n",
		);
	});

	it("converts images", () => {
		const blocks: PortableTextBlock[] = [
			{ _type: "image", _key: "i1", alt: "A cat", asset: { url: "/img/cat.jpg" } },
		];
		expect(portableTextToMarkdown(blocks)).toBe("![A cat](/img/cat.jpg)\n");
	});

	it("serializes unknown blocks as opaque fences", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "block",
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", text: "Before", marks: [] }],
			},
			{
				_type: "pluginWidget",
				_key: "pw1",
				config: { layout: "grid", items: 3 },
			},
			{
				_type: "block",
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", text: "After", marks: [] }],
			},
		];

		const md = portableTextToMarkdown(blocks);
		expect(md).toContain("Before");
		expect(md).toContain("After");
		expect(md).toContain("<!--ec:block ");
		expect(md).toContain('"_type":"pluginWidget"');
		expect(md).toContain('"layout":"grid"');
	});

	it("handles mixed content with paragraphs, headings, and lists", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "block",
				style: "h1",
				markDefs: [],
				children: [{ _type: "span", text: "Title", marks: [] }],
			},
			{
				_type: "block",
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", text: "A paragraph.", marks: [] }],
			},
			{
				_type: "block",
				style: "normal",
				listItem: "bullet",
				level: 1,
				markDefs: [],
				children: [{ _type: "span", text: "Item", marks: [] }],
			},
		];

		const md = portableTextToMarkdown(blocks);
		expect(md).toContain("# Title");
		expect(md).toContain("A paragraph.");
		expect(md).toContain("- Item");
	});
});

// ---------------------------------------------------------------------------
// Markdown -> PT
// ---------------------------------------------------------------------------

describe("markdownToPortableText", () => {
	it("converts a simple paragraph", () => {
		const blocks = markdownToPortableText("Hello world\n");
		expect(blocks).toHaveLength(1);
		expect(blocks[0]._type).toBe("block");
		expect(blocks[0].style).toBe("normal");
		expect(blocks[0].children).toHaveLength(1);
		expect((blocks[0].children[0] as { text: string }).text).toBe("Hello world");
	});

	it("converts headings", () => {
		const blocks = markdownToPortableText("# Title\n\n### Subtitle\n");
		expect(blocks).toHaveLength(2);
		expect(blocks[0].style).toBe("h1");
		expect(blocks[1].style).toBe("h3");
	});

	it("converts bold and italic", () => {
		const blocks = markdownToPortableText("Some **bold** and _italic_ text\n");
		expect(blocks).toHaveLength(1);
		const children = blocks[0].children;
		expect(children.length).toBeGreaterThan(1);

		const boldSpan = children.find((c) => (c.marks ?? []).includes("strong"));
		expect(boldSpan).toBeDefined();
		expect(boldSpan!.text).toBe("bold");

		const italicSpan = children.find((c) => (c.marks ?? []).includes("em"));
		expect(italicSpan).toBeDefined();
		expect(italicSpan!.text).toBe("italic");
	});

	it("converts inline code", () => {
		const blocks = markdownToPortableText("Use `foo()` here\n");
		const children = blocks[0].children;
		const codeSpan = children.find((c) => (c.marks ?? []).includes("code"));
		expect(codeSpan).toBeDefined();
		expect(codeSpan!.text).toBe("foo()");
	});

	it("converts links with markDefs", () => {
		const blocks = markdownToPortableText("Click [here](https://example.com)\n");
		expect(blocks).toHaveLength(1);
		expect(blocks[0].markDefs).toHaveLength(1);
		expect(blocks[0].markDefs[0]._type).toBe("link");
		expect(blocks[0].markDefs[0].href).toBe("https://example.com");

		const linkSpan = blocks[0].children.find((c) =>
			(c.marks ?? []).includes(blocks[0].markDefs[0]._key),
		);
		expect(linkSpan).toBeDefined();
		expect(linkSpan!.text).toBe("here");
	});

	it("converts blockquotes", () => {
		const blocks = markdownToPortableText("> A quote\n");
		expect(blocks).toHaveLength(1);
		expect(blocks[0].style).toBe("blockquote");
	});

	it("converts unordered lists", () => {
		const blocks = markdownToPortableText("- First\n- Second\n  - Nested\n");
		expect(blocks).toHaveLength(3);
		expect(blocks[0].listItem).toBe("bullet");
		expect(blocks[0].level).toBe(1);
		expect(blocks[2].listItem).toBe("bullet");
		expect(blocks[2].level).toBe(2);
	});

	it("converts ordered lists", () => {
		const blocks = markdownToPortableText("1. First\n2. Second\n");
		expect(blocks).toHaveLength(2);
		expect(blocks[0].listItem).toBe("number");
		expect(blocks[1].listItem).toBe("number");
	});

	it("converts code fences", () => {
		const blocks = markdownToPortableText("```typescript\nconst x = 1;\n```\n");
		expect(blocks).toHaveLength(1);
		expect(blocks[0]._type).toBe("code");
		expect(blocks[0].language).toBe("typescript");
		expect(blocks[0].code).toBe("const x = 1;");
	});

	it("converts images", () => {
		const blocks = markdownToPortableText("![A cat](/img/cat.jpg)\n");
		expect(blocks).toHaveLength(1);
		expect(blocks[0]._type).toBe("image");
		expect(blocks[0].alt).toBe("A cat");
		expect((blocks[0].asset as { url: string }).url).toBe("/img/cat.jpg");
	});

	it("deserializes opaque fences back to original blocks", () => {
		const original = {
			_type: "pluginWidget",
			_key: "pw1",
			config: { layout: "grid", items: 3 },
		};
		const md = `<!--ec:block ${JSON.stringify(original)} -->`;
		const blocks = markdownToPortableText(md);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]._type).toBe("pluginWidget");
		expect(blocks[0]._key).toBe("pw1");
		expect((blocks[0] as Record<string, unknown>).config).toEqual({
			layout: "grid",
			items: 3,
		});
	});

	it("skips blank lines", () => {
		const blocks = markdownToPortableText("Hello\n\n\n\nWorld\n");
		expect(blocks).toHaveLength(2);
	});

	it("converts strikethrough", () => {
		const blocks = markdownToPortableText("Some ~~deleted~~ text\n");
		const children = blocks[0].children;
		const strikeSpan = children.find((c) => (c.marks ?? []).includes("strike-through"));
		expect(strikeSpan).toBeDefined();
		expect(strikeSpan!.text).toBe("deleted");
	});
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe("PT <-> Markdown round-trip", () => {
	it("preserves simple text through round-trip", () => {
		const original: PortableTextBlock[] = [
			{
				_type: "block",
				_key: "a",
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", _key: "s", text: "Hello world", marks: [] }],
			},
		];

		const md = portableTextToMarkdown(original);
		const roundTripped = markdownToPortableText(md);

		expect(roundTripped).toHaveLength(1);
		expect(roundTripped[0].style).toBe("normal");
		expect((roundTripped[0].children[0] as { text: string }).text).toBe("Hello world");
	});

	it("preserves headings through round-trip", () => {
		const original: PortableTextBlock[] = [
			{
				_type: "block",
				style: "h2",
				markDefs: [],
				children: [{ _type: "span", text: "My Heading", marks: [] }],
			},
		];

		const md = portableTextToMarkdown(original);
		const roundTripped = markdownToPortableText(md);

		expect(roundTripped).toHaveLength(1);
		expect(roundTripped[0].style).toBe("h2");
		expect((roundTripped[0].children[0] as { text: string }).text).toBe("My Heading");
	});

	it("preserves opaque fences through round-trip", () => {
		const custom = {
			_type: "callout",
			_key: "c1",
			style: "warning",
			text: "Be careful!",
		};

		const original: PortableTextBlock[] = [
			{
				_type: "block",
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", text: "Before", marks: [] }],
			},
			custom,
			{
				_type: "block",
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", text: "After", marks: [] }],
			},
		];

		const md = portableTextToMarkdown(original);
		const roundTripped = markdownToPortableText(md);

		expect(roundTripped).toHaveLength(3);
		expect(roundTripped[1]._type).toBe("callout");
		expect(roundTripped[1]._key).toBe("c1");
		expect((roundTripped[1] as Record<string, unknown>).style).toBe("warning");
		expect((roundTripped[1] as Record<string, unknown>).text).toBe("Be careful!");
	});

	it("preserves code blocks through round-trip", () => {
		const original: PortableTextBlock[] = [
			{
				_type: "code",
				_key: "c1",
				language: "javascript",
				code: "const x = 42;",
			},
		];

		const md = portableTextToMarkdown(original);
		const roundTripped = markdownToPortableText(md);

		expect(roundTripped).toHaveLength(1);
		expect(roundTripped[0]._type).toBe("code");
		expect(roundTripped[0].language).toBe("javascript");
		expect(roundTripped[0].code).toBe("const x = 42;");
	});

	it("preserves bold text through round-trip", () => {
		const original: PortableTextBlock[] = [
			{
				_type: "block",
				style: "normal",
				markDefs: [],
				children: [
					{ _type: "span", text: "Some ", marks: [] },
					{ _type: "span", text: "bold", marks: ["strong"] },
					{ _type: "span", text: " text", marks: [] },
				],
			},
		];

		const md = portableTextToMarkdown(original);
		expect(md).toContain("**bold**");

		const roundTripped = markdownToPortableText(md);
		const boldSpan = roundTripped[0].children.find((c) => (c.marks ?? []).includes("strong"));
		expect(boldSpan).toBeDefined();
		expect(boldSpan!.text).toBe("bold");
	});
});

// ---------------------------------------------------------------------------
// Schema-aware conversion
// ---------------------------------------------------------------------------

describe("convertDataForRead", () => {
	const fields: FieldSchema[] = [
		{ slug: "title", type: "string" },
		{ slug: "body", type: "portableText" },
		{ slug: "sidebar", type: "portableText" },
	];

	it("converts PT arrays to markdown for portableText fields", () => {
		const data = {
			title: "Hello",
			body: [
				{
					_type: "block",
					style: "normal",
					markDefs: [],
					children: [{ _type: "span", text: "Content", marks: [] }],
				},
			],
		};

		const result = convertDataForRead(data, fields);
		expect(result.title).toBe("Hello");
		expect(typeof result.body).toBe("string");
		expect(result.body).toContain("Content");
	});

	it("skips conversion when raw is true", () => {
		const data = {
			body: [{ _type: "block", children: [{ _type: "span", text: "X" }] }],
		};

		const result = convertDataForRead(data, fields, true);
		expect(Array.isArray(result.body)).toBe(true);
	});

	it("does not touch non-portableText fields", () => {
		const data = { title: "Test", body: "already a string" };
		const result = convertDataForRead(data, fields);
		expect(result.title).toBe("Test");
		expect(result.body).toBe("already a string"); // not an array, skip
	});
});

describe("convertDataForWrite", () => {
	const fields: FieldSchema[] = [
		{ slug: "title", type: "string" },
		{ slug: "body", type: "portableText" },
	];

	it("converts markdown strings to PT for portableText fields", () => {
		const data = { title: "Hello", body: "Some **bold** text" };
		const result = convertDataForWrite(data, fields);
		expect(result.title).toBe("Hello");
		expect(Array.isArray(result.body)).toBe(true);

		const blocks = result.body as PortableTextBlock[];
		expect(blocks[0]._type).toBe("block");
		const boldSpan = blocks[0].children.find((c) => (c.marks ?? []).includes("strong"));
		expect(boldSpan!.text).toBe("bold");
	});

	it("passes through raw PT arrays unchanged", () => {
		const ptArray = [{ _type: "block", children: [{ _type: "span", text: "Raw" }] }];
		const data = { body: ptArray };
		const result = convertDataForWrite(data, fields);
		expect(result.body).toBe(ptArray); // same reference
	});
});
