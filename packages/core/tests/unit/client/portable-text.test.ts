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
			"**bold** and *italic* and `code` and ~~struck~~\n",
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

	it("preserves marks when links are nested inside or outside strong text", () => {
		const blocks = markdownToPortableText(
			"**[Bold Link](https://example.com)** and [**Link with bold**](https://example.org)\n",
		);
		const links = blocks[0].markDefs;
		expect(links).toHaveLength(2);
		expect(blocks[0].children).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ text: "Bold Link", marks: expect.arrayContaining(["strong"]) }),
				expect.objectContaining({
					text: "Link with bold",
					marks: expect.arrayContaining(["strong"]),
				}),
			]),
		);
		const linkKeys = links.map((def) => def._key);
		for (const span of blocks[0].children.filter((child) =>
			/Bold Link|Link with bold/.test(child.text),
		)) {
			expect(span.marks).toEqual(expect.arrayContaining(["strong"]));
			expect(linkKeys).toContain(span.marks.find((mark) => linkKeys.includes(mark)));
		}
	});

	it("parses nested marks and resolves link marks on the actual spans", () => {
		const block = markdownToPortableText(
			"*italic* **strong _em `code` ~~strike~~_** [**linked**](https://example.com)\n",
		)[0];
		const spans = new Map(block.children.map((child) => [child.text, child]));
		const linkKey = block.markDefs.find(
			(def) => def._type === "link" && def.href === "https://example.com",
		)?._key;

		expect(spans.get("italic")?.marks).toEqual(["em"]);
		expect(spans.get("code")?.marks).toEqual(["strong", "em", "code"]);
		expect(spans.get("strike")?.marks).toEqual(["strong", "em", "strike-through"]);
		expect(linkKey).toBeDefined();
		expect(spans.get("linked")?.marks).toEqual(expect.arrayContaining(["strong", linkKey]));
		expect(spans.get("linked")?.marks).toHaveLength(2);
		expect(block.markDefs).toEqual([
			expect.objectContaining({ _type: "link", href: "https://example.com", _key: linkKey }),
		]);

		const compound = {
			...block,
			children: [{ _type: "span", text: "compound", marks: ["strong", "em", "code", linkKey] }],
		};
		const roundTripped = markdownToPortableText(portableTextToMarkdown([compound]))[0];
		const roundTrippedSpan = roundTripped.children.find((child) => child.text === "compound");
		const roundTrippedLinkKey = roundTripped.markDefs.find(
			(def) => def._type === "link" && def.href === "https://example.com",
		)?._key;
		expect(roundTrippedSpan?.marks).toEqual(
			expect.arrayContaining(["strong", "em", "code", roundTrippedLinkKey]),
		);
		expect(roundTrippedSpan?.marks).toHaveLength(4);
	});

	it("imports GFM tables into the native table block shape", () => {
		const [table] = markdownToPortableText("| Name | Score |\n| :--- | ---: |\n| Ada | 10 |\n");
		expect(table).toMatchObject({ _type: "table", hasHeaderRow: true });
		expect(table.rows).toHaveLength(2);
		expect(table.rows.map((row) => row._type)).toEqual(["tableRow", "tableRow"]);
		expect(table.rows.map((row) => row.cells.map((cell) => cell._type))).toEqual([
			["tableCell", "tableCell"],
			["tableCell", "tableCell"],
		]);
		expect(table.rows[0].cells.map((cell) => cell.content[0].text)).toEqual(["Name", "Score"]);
		expect(table.rows[0].cells.every((cell) => cell.isHeader)).toBe(true);
		expect(table.rows[1].cells.map((cell) => cell.content[0].text)).toEqual(["Ada", "10"]);
	});

	it("round-trips a native table with header cells and cell content", () => {
		const original: PortableTextBlock[] = [
			{
				_type: "table",
				_key: "table",
				hasHeaderRow: true,
				rows: [
					{
						_type: "tableRow",
						_key: "header",
						cells: [
							{
								_type: "tableCell",
								_key: "h1",
								isHeader: true,
								content: [{ _type: "span", _key: "s1", text: "Name" }],
							},
							{
								_type: "tableCell",
								_key: "h2",
								isHeader: true,
								content: [{ _type: "span", _key: "s2", text: "Score" }],
							},
						],
					},
					{
						_type: "tableRow",
						_key: "body",
						cells: [
							{
								_type: "tableCell",
								_key: "c1",
								content: [{ _type: "span", _key: "s3", text: "Ada" }],
							},
							{
								_type: "tableCell",
								_key: "c2",
								content: [{ _type: "span", _key: "s4", text: "10" }],
							},
						],
					},
				],
			},
		];
		const markdown = portableTextToMarkdown(original);
		expect(markdown).toContain("| Name | Score |");
		expect(markdown).not.toContain("<!--ec:block");
		const roundTripped = markdownToPortableText(markdown);
		expect(roundTripped[0]).toMatchObject({ _type: "table", hasHeaderRow: true });
		expect(
			roundTripped[0].rows.map((row) => row.cells.map((cell) => cell.content[0].text)),
		).toEqual([
			["Name", "Score"],
			["Ada", "10"],
		]);
	});

	it("retains mixed list types and indentation levels", () => {
		const blocks = markdownToPortableText("1. One\n   1. Two\n    - Three\n       * Four\n");
		expect(blocks.map((block) => [block.listItem, block.level])).toEqual([
			["number", 1],
			["number", 2],
			["bullet", 2],
			["bullet", 3],
		]);
	});

	it("keeps wrapped paragraphs, escaped literals, references, and multiline quotes", () => {
		const blocks = markdownToPortableText(
			"wrapped first line\nwrapped second line\n\nEscaped \\*literal\\* and [reference][id]\n\n> first quote\n> second quote\n\n[id]: https://example.com\n",
		);
		expect(blocks).toHaveLength(3);
		expect(blocks[0].children.map((child) => child.text).join("")).toContain("wrapped first line");
		expect(blocks[0].children.map((child) => child.text).join("")).toContain("wrapped second line");
		expect(blocks[1].children.map((child) => child.text).join("")).toContain("*literal*");
		expect(blocks[1].markDefs).toEqual([
			expect.objectContaining({ _type: "link", href: "https://example.com" }),
		]);
		expect(blocks[2]).toMatchObject({ _type: "block", style: "blockquote" });
		expect(blocks[2].children.map((child) => child.text).join("")).toContain("first quote");
		expect(blocks[2].children.map((child) => child.text).join("")).toContain("second quote");
	});

	it("keeps strong edge whitespace and intraword emphasis through Markdown round-trip", () => {
		const original: PortableTextBlock[] = [
			{
				_type: "block",
				style: "normal",
				markDefs: [],
				children: [
					{ _type: "span", text: " bold ", marks: ["strong"] },
					{ _type: "span", text: "bar", marks: [] },
					{ _type: "span", text: "foo", marks: ["em"] },
					{ _type: "span", text: "baz", marks: [] },
				],
			},
		];

		const roundTripped = markdownToPortableText(portableTextToMarkdown(original));
		const perCharacterMarks = (block: PortableTextBlock) =>
			block.children.flatMap((span) =>
				Array.from(span.text ?? "", (character) => ({
					character,
					marks: character.trim() ? (span.marks ?? []) : [],
				})),
			);
		expect(perCharacterMarks(roundTripped[0])).toEqual(perCharacterMarks(original[0]));
	});

	it("preserves unsupported table content and fields as opaque blocks", () => {
		const variants: Array<{
			marks: string[];
			markDefs?: Array<Record<string, unknown>>;
			cellFields?: Record<string, unknown>;
			tableFields?: Record<string, unknown>;
		}> = [
			{ marks: ["underline"] },
			{ marks: ["subscript"] },
			{ marks: ["superscript"] },
			{
				marks: ["annotation"],
				markDefs: [{ _key: "annotation", _type: "annotation", value: "x" }],
			},
			{ marks: ["link"], markDefs: [{ _key: "link", _type: "link", href: "/x", blank: true }] },
			{
				marks: [],
				cellFields: { unknownCellField: true },
				tableFields: { unknownTableField: "kept" },
			},
		];
		const tables = variants.map((variant, index) => ({
			_type: "table",
			_key: `unsupported-${index}`,
			...variant.tableFields,
			hasHeaderRow: true,
			rows: [
				{
					_type: "tableRow",
					cells: [
						{
							_type: "tableCell",
							_key: `cell-${index}`,
							...variant.cellFields,
							content: [{ _type: "span", text: "value", marks: variant.marks }],
							...(variant.markDefs ? { markDefs: variant.markDefs } : {}),
							isHeader: true,
						},
					],
				},
			],
		})) as unknown as PortableTextBlock[];

		for (const table of tables) {
			const markdown = portableTextToMarkdown([table]);
			expect(markdown).toBe(`<!--ec:block ${JSON.stringify(table)} -->\n`);
			expect(markdownToPortableText(markdown)[0]).toEqual(table);
		}
	});

	it("does not link plain URLs or email addresses, but imports angle autolinks", () => {
		const [block] = markdownToPortableText(
			"https://plain.example alice@example.com <https://explicit.example>\n",
		);
		expect(block.markDefs).toEqual([
			expect.objectContaining({ _type: "link", href: "https://explicit.example" }),
		]);
		expect(
			block.children.find((span) => span.text?.includes("https://plain.example"))?.marks,
		).toEqual([]);
		expect(block.children.find((span) => span.text?.includes("alice@example.com"))?.marks).toEqual(
			[],
		);
		const explicit = block.children.find((span) => span.text === "https://explicit.example");
		expect(explicit?.marks).toContain(block.markDefs[0]._key);
	});

	it("keeps tight and loose task list items as one item", () => {
		for (const markdown of ["- [ ] Buy milk\n- [x] Done\n", "- [ ] Buy milk\n\n- [x] Done\n"]) {
			const blocks = markdownToPortableText(markdown);
			expect(blocks).toHaveLength(2);
			expect(blocks.map((block) => block.listItem)).toEqual(["bullet", "bullet"]);
			expect(blocks.map((block) => block.children.map((span) => span.text).join(""))).toEqual([
				"[ ] Buy milk",
				"[x] Done",
			]);
		}
	});

	it("distinguishes soft wraps, hard breaks, and Portable Text newlines", () => {
		const blocks = markdownToPortableText("soft one\nsoft two\n\nhard one  \nhard two\n");
		expect(blocks[0].children.map((span) => span.text).join("")).toBe("soft one soft two");
		expect(blocks[1].children.map((span) => span.text).join("")).toBe("hard one\nhard two");

		const original: PortableTextBlock[] = [
			{
				_type: "block",
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", text: "first\nsecond", marks: [] }],
			},
		];
		const markdown = portableTextToMarkdown(original);
		expect(
			markdownToPortableText(markdown)[0]
				.children.map((span) => span.text)
				.join(""),
		).toBe("first\nsecond");
	});

	it("does not inject backslashes into code newlines or a trailing block break", () => {
		for (const [text, marks, expected] of [
			["a\nb", ["code"], "a b"],
			["text\n", [], "text"],
		] as const) {
			const original: PortableTextBlock[] = [
				{ _type: "block", children: [{ _type: "span", text, marks: [...marks] }] },
			];
			const [block] = markdownToPortableText(portableTextToMarkdown(original));
			expect(block.children.map((span) => span.text).join("")).toBe(expected);
		}
	});

	it("preserves opaque and malformed comment sequences as distinct content", () => {
		const opaque = { _type: "callout", _key: "opaque", text: "kept" };
		const blocks = markdownToPortableText(
			`before\n\n<!--ec:block ${JSON.stringify(opaque)} -->\n\n<!--ec:block {malformed} -->\n<!-- ordinary comment -->\n`,
		);
		expect(blocks[1]).toMatchObject(opaque);
		expect(blocks[2].children[0].text).toBe("<!--ec:block {malformed} -->");
		expect(blocks[3].children[0].text).toBe("<!-- ordinary comment -->");
	});

	it("keeps escaped punctuation and backslashes as literal text", () => {
		const markdown = "Escaped \\*asterisks\\* \\_underscores\\_ \\[brackets\\] and \\\\backslash";
		const [block] = markdownToPortableText(markdown);
		expect(block.children.map((child) => child.text).join("")).toBe(
			"Escaped *asterisks* _underscores_ [brackets] and \\backslash",
		);
		expect(block.children.every((child) => child.marks?.length === 0)).toBe(true);
	});

	it("parses code spans containing backticks", () => {
		const [block] = markdownToPortableText("Use ``a `backtick` value`` here\n");
		const codeSpan = block.children.find((child) => child.marks?.includes("code"));
		expect(codeSpan).toMatchObject({ text: "a `backtick` value", marks: ["code"] });
	});

	it("parses table cell marks, escaped pipes, backslashes, and alignment", () => {
		const [table] = markdownToPortableText(
			"| Left | Right |\n| :--- | ---: |\n| **bold** and [link](https://example.com) | `code` and literal \\| pipe \\\\ |\n",
		);
		const cells = table.rows[1].cells;
		const leftText = cells[0].content.map((span) => span.text).join("");
		const rightText = cells[1].content.map((span) => span.text).join("");
		const linkKey = cells[0].markDefs.find((def) => def._type === "link")?._key;
		expect(table).toMatchObject({ _type: "table", hasHeaderRow: true });
		expect(table.rows[0].cells.map((cell) => cell.textAlign)).toEqual(["left", "right"]);
		expect(leftText).toBe("bold and link");
		expect(rightText).toBe("code and literal | pipe \\");
		expect(cells[0].content.find((span) => span.text === "bold")?.marks).toEqual(["strong"]);
		expect(cells[0].content.find((span) => span.text === "link")?.marks).toEqual([linkKey]);
		expect(cells[1].content.find((span) => span.text === "code")?.marks).toEqual(["code"]);
		expect(linkKey).toBeDefined();

		const roundTripped = markdownToPortableText(portableTextToMarkdown([table]))[0];
		expect(roundTripped.rows[0].cells.map((cell) => cell.textAlign)).toEqual(["left", "right"]);
		expect(
			roundTripped.rows[1].cells.map((cell) => cell.content.map((span) => span.text).join("")),
		).toEqual(["bold and link", "code and literal | pipe \\"]);
	});

	it("keeps unsupported native tables opaque and lossless", () => {
		const tables = [
			{
				_type: "table",
				_key: "merged",
				hasHeaderRow: true,
				rows: [{ _type: "tableRow", cells: [{ _type: "tableCell", colspan: 2, content: [] }] }],
			},
			{
				_type: "table",
				_key: "headerless",
				hasHeaderRow: false,
				rows: [{ _type: "tableRow", cells: [{ _type: "tableCell", content: [] }] }],
			},
			{
				_type: "table",
				_key: "legacy",
				headers: ["Name"],
				rows: [["Ada"]],
			},
		] as unknown as PortableTextBlock[];

		for (const table of tables) {
			const markdown = portableTextToMarkdown([table]);
			expect(markdown).toBe(`<!--ec:block ${JSON.stringify(table)} -->\n`);
			expect(markdownToPortableText(markdown)[0]).toEqual(table);
		}
	});

	it("does not throw for malformed native table rows", () => {
		const malformed = {
			_type: "table",
			_key: "malformed",
			hasHeaderRow: true,
			rows: [{ _type: "tableRow", cells: [{ _type: "tableCell", content: [] }] }, null],
		} as unknown as PortableTextBlock;

		expect(() => portableTextToMarkdown([malformed])).not.toThrow();
		expect(markdownToPortableText(portableTextToMarkdown([malformed]))[0]).toEqual(malformed);
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

	it("round-trips three mixed list levels with ordered-marker indentation", () => {
		const original: PortableTextBlock[] = [
			{ _type: "block", listItem: "number", level: 1, children: [{ _type: "span", text: "One" }] },
			{ _type: "block", listItem: "bullet", level: 2, children: [{ _type: "span", text: "Two" }] },
			{
				_type: "block",
				listItem: "number",
				level: 3,
				children: [{ _type: "span", text: "Three" }],
			},
		];

		const markdown = portableTextToMarkdown(original);
		expect(markdown).toBe("1. One\n   - Two\n     1. Three\n");
		expect(
			markdownToPortableText(markdown).map((block) => [
				block.listItem,
				block.level,
				block.children[0].text,
			]),
		).toEqual([
			["number", 1, "One"],
			["bullet", 2, "Two"],
			["number", 3, "Three"],
		]);
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
