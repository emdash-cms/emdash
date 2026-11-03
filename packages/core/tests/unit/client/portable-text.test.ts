import { describe, it, expect, beforeEach } from "vitest";

import type {
	PortableTextBlock,
	PortableTextTableBlock,
	PortableTextTableRow,
	PortableTextTableCell,
	FieldSchema,
} from "../../../src/client/portable-text.js";
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

	it("converts canonical table blocks to GFM tables", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "table",
				hasHeaderRow: true,
				rows: [
					{
						_type: "tableRow",
						_key: "r1",
						cells: [
							{
								_type: "tableCell",
								_key: "c1",
								isHeader: true,
								content: [{ _type: "span", text: "Fruit", marks: [] }],
							},
							{
								_type: "tableCell",
								_key: "c2",
								isHeader: true,
								content: [{ _type: "span", text: "Color", marks: [] }],
							},
						],
					},
					{
						_type: "tableRow",
						_key: "r2",
						cells: [
							{
								_type: "tableCell",
								_key: "c3",
								content: [{ _type: "span", text: "Apple", marks: [] }],
							},
							{
								_type: "tableCell",
								_key: "c4",
								content: [{ _type: "span", text: "Red", marks: [] }],
							},
						],
					},
					{
						_type: "tableRow",
						_key: "r3",
						cells: [
							{
								_type: "tableCell",
								_key: "c5",
								content: [{ _type: "span", text: "Banana", marks: [] }],
							},
							{
								_type: "tableCell",
								_key: "c6",
								content: [{ _type: "span", text: "Yellow", marks: [] }],
							},
						],
					},
				],
			},
		];
		expect(portableTextToMarkdown(blocks)).toBe(
			"| Fruit | Color |\n| --- | --- |\n| Apple | Red |\n| Banana | Yellow |\n",
		);
	});

	it("preserves canonical tables with colspan/rowspan as opaque fences", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "table",
				hasHeaderRow: true,
				rows: [
					{
						_type: "tableRow",
						_key: "r1",
						cells: [
							{
								_type: "tableCell",
								_key: "c1",
								isHeader: true,
								colspan: 2,
								content: [{ _type: "span", text: "Merged Header", marks: [] }],
							},
						],
					},
				],
			},
		];
		const md = portableTextToMarkdown(blocks);
		expect(md).toContain("<!--ec:block ");
		expect(md).toContain('"colspan":2');
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

	it("converts GFM tables into canonical table blocks with cell marks and alignment", () => {
		const md =
			"| Name | Role |\n| :--- | :---: |\n| **Alice** | [Admin](https://example.com) |\n";
		const blocks = markdownToPortableText(md);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]._type).toBe("table");
		expect(blocks[0].hasHeaderRow).toBe(true);

		const rows = blocks[0].rows as PortableTextTableRow[];
		expect(rows).toHaveLength(2);

		// Header row
		expect(rows[0].cells).toHaveLength(2);
		expect(rows[0].cells[0].isHeader).toBe(true);
		expect(rows[0].cells[0].textAlign).toBe("left");
		expect(rows[0].cells[0].content[0].text).toBe("Name");

		expect(rows[0].cells[1].isHeader).toBe(true);
		expect(rows[0].cells[1].textAlign).toBe("center");
		expect(rows[0].cells[1].content[0].text).toBe("Role");

		// Body row with bold and link
		expect(rows[1].cells).toHaveLength(2);
		expect(rows[1].cells[0].content[0].text).toBe("Alice");
		expect(rows[1].cells[0].content[0].marks).toContain("strong");

		expect(rows[1].cells[1].content[0].text).toBe("Admin");
		expect(rows[1].cells[1].markDefs).toBeDefined();
		expect(rows[1].cells[1].markDefs![0].href).toBe("https://example.com");
	});

	it("preserves multiple paragraphs in a loose list item with word separation", () => {
		const md = "- One\n\n  Two\n";
		const blocks = markdownToPortableText(md);
		expect(blocks).toHaveLength(1);
		const fullText = (blocks[0].children as Array<{ text: string }>).map((c) => c.text).join("");
		expect(fullText).toContain("One");
		expect(fullText).toContain("Two");
		expect(fullText).not.toBe("OneTwo");
	});

	it("splits multiple images in a paragraph and preserves alt and url", () => {
		const md = "![Cat](/cat.jpg)\n![Dog](/dog.jpg)\n";
		const blocks = markdownToPortableText(md);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]._type).toBe("image");
		expect(blocks[0].alt).toBe("Cat");
		expect((blocks[0].asset as { url: string }).url).toBe("/cat.jpg");
		expect(blocks[1]._type).toBe("image");
		expect(blocks[1].alt).toBe("Dog");
		expect((blocks[1].asset as { url: string }).url).toBe("/dog.jpg");
	});

	it("splits image followed by caption in a paragraph", () => {
		const md = "![Cat](/cat.jpg)\nA cute cat caption\n";
		const blocks = markdownToPortableText(md);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]._type).toBe("image");
		expect((blocks[0].asset as { url: string }).url).toBe("/cat.jpg");
		expect(blocks[1]._type).toBe("block");
		expect(blocks[1].children[0].text).toBe("A cute cat caption");
	});

	it("preserves headings and lists inside blockquotes", () => {
		const md = "> # Important Header\n> - List item in quote\n";
		const blocks = markdownToPortableText(md);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].style).toBe("blockquote");
		expect(blocks[0].children[0].text).toBe("Important Header");
		expect(blocks[1].style).toBe("blockquote");
		expect(blocks[1].children[0].text).toBe("List item in quote");
	});

	it("preserves unsupported literal HTML as text", () => {
		const md = "<div>Keep me</div>\n";
		const blocks = markdownToPortableText(md);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]._type).toBe("block");
		expect(blocks[0].children[0].text).toBe("<div>Keep me</div>");

		// and round-trips
		const roundTrip = portableTextToMarkdown(blocks);
		expect(roundTrip).toContain("<div>Keep me</div>");
	});

	it("converts compound marks such as bold hyperlinks and bold italic", () => {
		const md = "Paragraph with **[Bold Link](https://example.com)** and ***bold italic***.\n";
		const blocks = markdownToPortableText(md);
		expect(blocks).toHaveLength(1);
		const linkDef = blocks[0].markDefs.find((m) => m._type === "link");
		expect(linkDef).toBeDefined();
		expect(linkDef?.href).toBe("https://example.com");

		const boldLinkSpan = blocks[0].children.find((c) => c.text === "Bold Link");
		expect(boldLinkSpan).toBeDefined();
		expect(boldLinkSpan?.marks).toContain("strong");
		expect(boldLinkSpan?.marks).toContain(linkDef?._key);

		const boldItalicSpan = blocks[0].children.find((c) => c.text === "bold italic");
		expect(boldItalicSpan).toBeDefined();
		expect(boldItalicSpan?.marks).toContain("strong");
		expect(boldItalicSpan?.marks).toContain("em");
	});

	it("converts deep nested lists with levels 1, 2, and 3", () => {
		const md = "- Level 1\n  - Level 2a\n  - Level 2b\n    - Level 3\n- Level 1 again\n";
		const blocks = markdownToPortableText(md);
		expect(blocks).toHaveLength(5);
		expect(blocks.map((b) => [b.listItem, b.level])).toEqual([
			["bullet", 1],
			["bullet", 2],
			["bullet", 2],
			["bullet", 3],
			["bullet", 1],
		]);
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

	it("preserves canonical tables through round-trip", () => {
		const original: PortableTextBlock = {
			_type: "table",
			hasHeaderRow: true,
			rows: [
				{
					_type: "tableRow",
					_key: "r1",
					cells: [
						{
							_type: "tableCell",
							_key: "c1",
							isHeader: true,
							content: [{ _type: "span", text: "Header A", marks: [] }],
						},
						{
							_type: "tableCell",
							_key: "c2",
							isHeader: true,
							content: [{ _type: "span", text: "Header B", marks: [] }],
						},
					],
				},
				{
					_type: "tableRow",
					_key: "r2",
					cells: [
						{
							_type: "tableCell",
							_key: "c3",
							content: [{ _type: "span", text: "Row 1A", marks: [] }],
						},
						{
							_type: "tableCell",
							_key: "c4",
							content: [{ _type: "span", text: "Row 1B", marks: [] }],
						},
					],
				},
			],
		};

		const md = portableTextToMarkdown([original]);
		const roundTripped = markdownToPortableText(md);

		expect(roundTripped).toHaveLength(1);
		expect(roundTripped[0]._type).toBe("table");
		expect(roundTripped[0].hasHeaderRow).toBe(true);

		const rows = roundTripped[0].rows as PortableTextTableRow[];
		expect(rows).toHaveLength(2);
		expect(rows[0].cells[0].content[0].text).toBe("Header A");
		expect(rows[0].cells[1].content[0].text).toBe("Header B");
		expect(rows[1].cells[0].content[0].text).toBe("Row 1A");
		expect(rows[1].cells[1].content[0].text).toBe("Row 1B");
	});

	it("preserves nested numbered lists through round-trip", () => {
		const original: PortableTextBlock[] = [
			{
				_type: "block",
				_key: "n1",
				listItem: "number",
				level: 1,
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", text: "Parent", marks: [] }],
			},
			{
				_type: "block",
				_key: "n2",
				listItem: "number",
				level: 2,
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", text: "Child", marks: [] }],
			},
		];

		const md = portableTextToMarkdown(original);
		const roundTripped = markdownToPortableText(md);

		expect(roundTripped).toHaveLength(2);
		expect(roundTripped[0].listItem).toBe("number");
		expect(roundTripped[0].level).toBe(1);
		expect(roundTripped[1].listItem).toBe("number");
		expect(roundTripped[1].level).toBe(2);
	});

	it("preserves mixed nested lists (number -> bullet -> number) through round-trip", () => {
		const original: PortableTextBlock[] = [
			{
				_type: "block",
				_key: "m1",
				listItem: "number",
				level: 1,
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", text: "L1 Num", marks: [] }],
			},
			{
				_type: "block",
				_key: "m2",
				listItem: "bullet",
				level: 2,
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", text: "L2 Bullet", marks: [] }],
			},
			{
				_type: "block",
				_key: "m3",
				listItem: "number",
				level: 3,
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", text: "L3 Num", marks: [] }],
			},
		];

		const md = portableTextToMarkdown(original);
		expect(md).toBe("1. L1 Num\n   - L2 Bullet\n     1. L3 Num\n");

		const roundTripped = markdownToPortableText(md);
		expect(roundTripped).toHaveLength(3);
		expect(roundTripped[0].listItem).toBe("number");
		expect(roundTripped[0].level).toBe(1);
		expect(roundTripped[1].listItem).toBe("bullet");
		expect(roundTripped[1].level).toBe(2);
		expect(roundTripped[2].listItem).toBe("number");
		expect(roundTripped[2].level).toBe(3);
	});

	it("preserves mixed nested lists (bullet -> number -> bullet) through round-trip", () => {
		const original: PortableTextBlock[] = [
			{
				_type: "block",
				_key: "b1",
				listItem: "bullet",
				level: 1,
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", text: "L1 Bullet", marks: [] }],
			},
			{
				_type: "block",
				_key: "b2",
				listItem: "number",
				level: 2,
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", text: "L2 Num", marks: [] }],
			},
			{
				_type: "block",
				_key: "b3",
				listItem: "bullet",
				level: 3,
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", text: "L3 Bullet", marks: [] }],
			},
		];

		const md = portableTextToMarkdown(original);
		expect(md).toBe("- L1 Bullet\n  1. L2 Num\n     - L3 Bullet\n");

		const roundTripped = markdownToPortableText(md);
		expect(roundTripped).toHaveLength(3);
		expect(roundTripped[0].listItem).toBe("bullet");
		expect(roundTripped[0].level).toBe(1);
		expect(roundTripped[1].listItem).toBe("number");
		expect(roundTripped[1].level).toBe(2);
		expect(roundTripped[2].listItem).toBe("bullet");
		expect(roundTripped[2].level).toBe(3);
	});

	it("resolves table-level shared link markDefs in table cells", () => {
		const table: PortableTextTableBlock = {
			_type: "table",
			_key: "tbl-shared-mark",
			hasHeaderRow: true,
			markDefs: [
				{
					_key: "sharedLink1",
					_type: "link",
					href: "https://example.org/docs",
				},
			],
			rows: [
				{
					_type: "tableRow",
					_key: "r1",
					cells: [
						{
							_type: "tableCell",
							_key: "c1",
							isHeader: true,
							content: [{ _type: "span", text: "Header", marks: [] }],
						},
					],
				},
				{
					_type: "tableRow",
					_key: "r2",
					cells: [
						{
							_type: "tableCell",
							_key: "c2",
							content: [{ _type: "span", text: "Docs Link", marks: ["sharedLink1"] }],
						},
					],
				},
			],
		};

		const md = portableTextToMarkdown([table]);
		expect(md).toContain("[Docs Link](https://example.org/docs)");

		const roundTripped = markdownToPortableText(md);
		expect(roundTripped).toHaveLength(1);
		expect(roundTripped[0]._type).toBe("table");
		const rows = roundTripped[0].rows as PortableTextTableRow[];
		expect(rows[1].cells[0].content[0].text).toBe("Docs Link");
		expect(rows[1].cells[0].markDefs).toBeDefined();
		expect(rows[1].cells[0].markDefs![0].href).toBe("https://example.org/docs");
	});

	it("falls back to opaque fence for canonical tables with non-GFM formatting", () => {
		// 1. Body cell with differing textAlign from column header
		const diffAlignTable: PortableTextTableBlock = {
			_type: "table",
			_key: "tbl-diff-align",
			hasHeaderRow: true,
			rows: [
				{
					_type: "tableRow",
					_key: "r1",
					cells: [
						{
							_type: "tableCell",
							_key: "c1",
							isHeader: true,
							textAlign: "left",
							content: [{ _type: "span", text: "Col 1", marks: [] }],
						},
					],
				},
				{
					_type: "tableRow",
					_key: "r2",
					cells: [
						{
							_type: "tableCell",
							_key: "c2",
							textAlign: "right",
							content: [{ _type: "span", text: "Right Val", marks: [] }],
						},
					],
				},
			],
		};
		const mdDiffAlign = portableTextToMarkdown([diffAlignTable]);
		expect(mdDiffAlign).toContain("<!--ec:block");
		const roundTrippedDiffAlign = markdownToPortableText(mdDiffAlign);
		expect(roundTrippedDiffAlign[0]).toEqual(diffAlignTable);

		// 2. Table cell with colwidth
		const colwidthTable: PortableTextTableBlock = {
			_type: "table",
			_key: "tbl-colwidth",
			hasHeaderRow: true,
			rows: [
				{
					_type: "tableRow",
					_key: "r1",
					cells: [
						{
							_type: "tableCell",
							_key: "c1",
							isHeader: true,
							colwidth: [180],
							content: [{ _type: "span", text: "Col 1", marks: [] }],
						},
					],
				},
			],
		};
		const mdColwidth = portableTextToMarkdown([colwidthTable]);
		expect(mdColwidth).toContain("<!--ec:block");
		expect(markdownToPortableText(mdColwidth)[0]).toEqual(colwidthTable);

		// 3. Body row with isHeader: true
		const bodyHeaderTable: PortableTextTableBlock = {
			_type: "table",
			_key: "tbl-body-header",
			hasHeaderRow: true,
			rows: [
				{
					_type: "tableRow",
					_key: "r1",
					cells: [
						{
							_type: "tableCell",
							_key: "c1",
							isHeader: true,
							content: [{ _type: "span", text: "Header", marks: [] }],
						},
					],
				},
				{
					_type: "tableRow",
					_key: "r2",
					cells: [
						{
							_type: "tableCell",
							_key: "c2",
							isHeader: true,
							content: [{ _type: "span", text: "Sub-Header", marks: [] }],
						},
					],
				},
			],
		};
		const mdBodyHeader = portableTextToMarkdown([bodyHeaderTable]);
		expect(mdBodyHeader).toContain("<!--ec:block");
		expect(markdownToPortableText(mdBodyHeader)[0]).toEqual(bodyHeaderTable);

		// 4. Cell with newline in content
		const newlineTable: PortableTextTableBlock = {
			_type: "table",
			_key: "tbl-newline",
			hasHeaderRow: true,
			rows: [
				{
					_type: "tableRow",
					_key: "r1",
					cells: [
						{
							_type: "tableCell",
							_key: "c1",
							isHeader: true,
							content: [{ _type: "span", text: "Line 1\nLine 2", marks: [] }],
						},
					],
				},
			],
		};
		const mdNewline = portableTextToMarkdown([newlineTable]);
		expect(mdNewline).toContain("<!--ec:block");
		expect(markdownToPortableText(mdNewline)[0]).toEqual(newlineTable);
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

describe("blocks Portable Text conversion", () => {
	const fields: FieldSchema[] = [
		{
			slug: "layout",
			type: "blocks",
			blockTypes: [
				{
					slug: "hero",
					currentVersion: 2,
					versions: [
						{ version: 1, fields: [{ slug: "body", type: "portableText" }] },
						{ version: 2, fields: [{ slug: "introduction", type: "portableText" }] },
					],
				},
			],
		},
	];

	it("does not add an omitted blocks field on read", () => {
		expect(convertDataForRead({ title: "Example" }, fields)).toStrictEqual({ title: "Example" });
	});

	it("does not add an omitted blocks field to a partial write", () => {
		expect(convertDataForWrite({ title: "Updated" }, fields)).toStrictEqual({ title: "Updated" });
	});

	it("uses the active version for a new keyless block write", () => {
		const result = convertDataForWrite(
			{ layout: [{ _type: "hero", introduction: "Hello **world**" }] },
			fields,
		);
		const block = (result.layout as Array<Record<string, unknown>>)[0]!;
		expect(Array.isArray(block.introduction)).toBe(true);
	});

	it("converts nested Markdown for the sole allowed type even with a retired type present", () => {
		const result = convertDataForWrite({ layout: [{ introduction: "Hello **world**" }] }, [
			{
				...fields[0]!,
				validation: { allowedTypes: ["hero"], retiredTypes: ["banner"] },
				blockTypes: [
					...fields[0]!.blockTypes!,
					{ slug: "banner", currentVersion: 1, versions: [{ version: 1, fields: [] }] },
				],
			},
		]);
		const block = (result.layout as Array<Record<string, unknown>>)[0]!;
		expect(block.introduction).toMatchObject([
			{ _type: "block", children: [{ text: "Hello " }, { text: "world", marks: ["strong"] }] },
		]);
	});

	it("uses each retained stored version on read", () => {
		const portableText = markdownToPortableText("Historical");
		const result = convertDataForRead(
			{
				layout: [
					{ _type: "hero", _version: 1, _key: "one", body: portableText },
					{ _type: "hero", _version: 2, _key: "two", introduction: portableText },
				],
			},
			fields,
		);
		const blocks = result.layout as Array<Record<string, unknown>>;
		expect(String(blocks[0]?.body)).toContain("Historical");
		expect(String(blocks[1]?.introduction)).toContain("Historical");
	});
});
