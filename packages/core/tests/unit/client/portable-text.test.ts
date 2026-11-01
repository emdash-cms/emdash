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

function spansOf(block: PortableTextBlock) {
	return (block.children ?? []).map((span) => [span.text, span.marks]);
}

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

	it("writes an italic span with a long run of inner spaces in linear time", () => {
		const text = `a${" ".repeat(200_000)}b`;
		const blocks: PortableTextBlock[] = [
			{
				_type: "block",
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", text, marks: ["em"] }],
			},
		];
		const start = performance.now();
		const markdown = portableTextToMarkdown(blocks);
		expect(performance.now() - start).toBeLessThan(1000);
		expect(markdown).toBe(`_${text}_\n`);
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

	describe("paragraphs and emphasis", () => {
		it("joins wrapped lines into one paragraph", () => {
			const blocks = markdownToPortableText("First line\n  second line\nthird line\n");
			expect(blocks.map(spansOf)).toEqual([[["First line second line third line", []]]]);
		});

		it.each([
			["two trailing spaces", "First line  \nsecond line\n"],
			["a trailing backslash", "First line\\\nsecond line\n"],
			["a line holding only a backslash", "First line\n\\\nsecond line\n"],
		])("keeps a hard line break marked by %s", (_label, markdown) => {
			expect(markdownToPortableText(markdown).map(spansOf)).toEqual([
				[["First line\nsecond line", []]],
			]);
		});

		it("joins a line with a long run of inner spaces in linear time", () => {
			const line = `a${" ".repeat(200_000)}\tb`;
			const start = performance.now();
			const blocks = markdownToPortableText(`${line}\nnext\n`);
			expect(performance.now() - start).toBeLessThan(1000);
			expect(blocks.map(spansOf)).toEqual([[[`${line} next`, []]]]);
		});

		it("reads many underscores that open no emphasis in linear time", () => {
			const markdown = " _x".repeat(70_000);
			const start = performance.now();
			const blocks = markdownToPortableText(markdown);
			expect(performance.now() - start).toBeLessThan(1000);
			expect(blocks.map(spansOf)).toEqual([[[markdown, []]]]);
		});

		it.each([
			["a heading", `#${"\t".repeat(200_000)}\r`],
			["a bullet item", `*${"\t".repeat(200_000)}\r`],
			["a numbered item", `0.${"\t".repeat(200_000)}\r`],
			["a thematic break of stars", `***${" ".repeat(200_000)}x`],
			["a thematic break of underscores", `___${"\t".repeat(200_000)}x`],
		])(
			"converts a line that starts like %s and holds a long run of whitespace in linear time",
			(_label, line) => {
				for (const markdown of [line, `Paragraph\n${line}`]) {
					const start = performance.now();
					portableTextToMarkdown(markdownToPortableText(markdown));
					expect(performance.now() - start).toBeLessThan(1000);
				}
			},
		);

		it("reads Markdown with Windows line endings like Markdown with Unix ones", () => {
			const markdown = "# Title\n- item\n\nFirst line  \nsecond line\\\nthird line\n";
			const fromWindows = markdownToPortableText(markdown.replaceAll("\n", "\r\n"));
			resetKeyCounter();
			expect(fromWindows).toEqual(markdownToPortableText(markdown));
		});

		it.each(["#  ", "-  ", "1.  "])(
			"reads %j, a marker followed only by spaces, as a paragraph",
			(line) => {
				const blocks = markdownToPortableText(`${line}\n`);
				expect(blocks.map((block) => [block.style, block.listItem])).toEqual([
					["normal", undefined],
				]);
				expect(blocks.map(spansOf)).toEqual([[[line, []]]]);
			},
		);

		it.each([
			["a heading", "## Next"],
			["a blockquote", "> Next"],
			["a bullet item", "- Next"],
			["a numbered item starting at 1", "1. Next"],
			["a code fence", "```\nNext\n```"],
			["an image", "![Next](/next.jpg)"],
			["an opaque block", '<!--ec:block {"_type":"widget"} -->'],
		])("ends a paragraph at %s", (_label, next) => {
			const blocks = markdownToPortableText(`Paragraph\n${next}\n`);
			expect(blocks).toHaveLength(2);
			expect(spansOf(blocks[0]!)).toEqual([["Paragraph", []]]);
		});

		it("keeps a wrapped line that starts with another number in the paragraph", () => {
			const blocks = markdownToPortableText("It was finished in\n2024. Then it shipped.\n");
			expect(blocks.map(spansOf)).toEqual([[["It was finished in 2024. Then it shipped.", []]]]);
		});

		it("keeps every item of a numbered list whose items wrap", () => {
			const blocks = markdownToPortableText(
				"1. Install the CLI and log in\n   with your token.\n2. Create the collection.\n3. Import the content.\n",
			);
			const items = blocks.filter((block) => block.listItem === "number").map(spansOf);
			expect(items).toEqual([
				[["Install the CLI and log in", []]],
				[["Create the collection.", []]],
				[["Import the content.", []]],
			]);
			expect(blocks.flatMap(spansOf).map(([text]) => text.trim())).toContain("with your token.");
		});

		it("keeps a wrapped line that starts with a number in a paragraph after a list", () => {
			const blocks = markdownToPortableText("- a\n\nThe project started in\n2019. It grew.\n");
			expect(blocks.map((block) => [block.listItem, spansOf(block)])).toEqual([
				["bullet", [["a", []]]],
				[undefined, [["The project started in 2019. It grew.", []]]],
			]);
		});

		it.each([
			["table rows", "| a | b |\n|---|---|\n| 1 | 2 |"],
			["a thematic break", "***"],
			["a setext underline", "---"],
		])("keeps one block per line for %s", (_label, lines) => {
			const markdown = `Paragraph\n${lines}\nAfter`;
			expect(markdownToPortableText(`${markdown}\n`).map(spansOf)).toEqual(
				markdown.split("\n").map((line) => [[line, []]]),
			);
		});

		it("reads a ~~~ fence as a code block", () => {
			const blocks = markdownToPortableText("Paragraph\n~~~\ncode  x\n  indented\n~~~\n");
			expect(blocks.map((block) => block._type)).toEqual(["block", "code"]);
			expect(blocks[1]!.code).toBe("code  x\n  indented");
		});

		it.each([
			["my_var_name", [["my_var_name", []]]],
			["_a_b_", [["a_b", ["em"]]]],
			["a _ b _ c", [["a _ b _ c", []]]],
			["foo_bar_", [["foo_bar_", []]]],
			["a _ b_ c", [["a _ b_ c", []]]],
			["a _b _ c", [["a _b _ c", []]]],
		])("reads underscores in %j", (markdown, spans) => {
			expect(markdownToPortableText(`${markdown}\n`).map(spansOf)).toEqual([spans]);
		});

		it("leaves underscores inside words on separate lines unformatted", () => {
			const blocks = markdownToPortableText("Rename file_name\nbefore you set user_id.\n");
			expect(blocks.map(spansOf)).toEqual([[["Rename file_name before you set user_id.", []]]]);
		});

		it.each([
			[
				"Some *italic* text",
				[
					["Some ", []],
					["italic", ["em"]],
					[" text", []],
				],
			],
			[
				"*Note:* at the start",
				[
					["Note:", ["em"]],
					[" at the start", []],
				],
			],
			["*across\nlines*", [["across lines", ["em"]]]],
			["2 * 3 * 4", [["2 * 3 * 4", []]]],
			["glob **/*.ts", [["glob **/*.ts", []]]],
			["5**2 = 25 and 3*4", [["5**2 = 25 and 3*4", []]]],
			["\\*args and \\*\\*kwargs", [["*args and **kwargs", []]]],
			["rename *.txt to \\*.md", [["rename *.txt to *.md", []]]],
			["2*3**2 = 18", [["2*3**2 = 18", []]]],
			[
				"*a **b** c*",
				[
					["*a ", []],
					["b", ["strong"]],
					[" c*", []],
				],
			],
		])("reads single asterisks in %j", (markdown, spans) => {
			expect(markdownToPortableText(`${markdown}\n`).map(spansOf)).toEqual([spans]);
		});

		it.each([
			["\\_not italic\\_ and \\[not a link\\](x)", [["_not italic_ and [not a link](x)", []]]],
			["C:\\\\Users and \\a", [["C:\\Users and \\a", []]]],
			["`a\\*b`", [["a\\*b", ["code"]]]],
			["C:\\\\\nnext", [["C:\\ next", []]]],
		])("reads backslash escapes in %j", (markdown, spans) => {
			expect(markdownToPortableText(`${markdown}\n`).map(spansOf)).toEqual([spans]);
		});
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

	describe("text that looks like Markdown", () => {
		type Child = string | [text: string, ...marks: string[]];

		function block(children: Child[], fields: Partial<PortableTextBlock> = {}): PortableTextBlock {
			return {
				_type: "block",
				style: "normal",
				markDefs: [],
				children: children.map((child) => {
					const [text, ...marks] = typeof child === "string" ? [child] : child;
					return { _type: "span", text, marks };
				}),
				...fields,
			};
		}

		function shapeOf(blocks: PortableTextBlock[]) {
			return blocks.map((b) => ({
				_type: b._type,
				style: b.style,
				listItem: b.listItem,
				spans: (b.children ?? []).map((span) => [
					span.text,
					span.marks?.map((mark) => b.markDefs?.find((d) => d._key === mark)?.href ?? mark),
				]),
			}));
		}

		function roundTrip(blocks: PortableTextBlock[]) {
			return markdownToPortableText(portableTextToMarkdown(blocks));
		}

		it.each([
			["literal asterisks and backslashes", [block(["x*y + y*z, a*b*c, \\*args and \\.env"])]],
			["glob patterns", [block(["Match **/*.ts and src/*.md"])]],
			[
				"asterisks and tildes next to marks",
				[block(["a*", ["b", "em"], "*c ~", ["d", "strike-through"], "~e \\", ["f", "code"]])],
			],
			["bold text that contains asterisks", [block([["a**b", "strong"]])]],
			["underscores", [block(["Set user_id, my_var_name, __init__, _private_ and a _ b _ c"])]],
			["literal tildes, backticks and brackets", [block(["a ~~b~~ c, `npm` and [docs](x)"])]],
			[
				"brackets next to and inside a link",
				[
					block(["see [", ["a](b", "l1"]], {
						markDefs: [{ _key: "l1", _type: "link", href: "/x" }],
					}),
				],
			],
			["a ~~~ divider", [block(["Before"]), block(["~~~"]), block(["After"])]],
			["a ``` paragraph", [block(["```"]), block(["After"])]],
			["a # line", [block(["# Not a heading\nLine two\n## Not a heading"])]],
			["numbered lines", [block(["2. Not a list\nLine two\n1. Not a list"])]],
			["other block markers", [block(["a\n> b\n- c\n+ d\n* e\n| f |\n---\n===\n* * *"])]],
			["image and opaque block lines", [block(['![x](y)\n<!--ec:block {"_type":"x"} -->'])]],
			["a line break", [block(["Line one\nline two"])]],
			["spaces and tabs before a line break", [block(["a  \nb\t\nc"])]],
			["no-break and ideographic spaces at the start of a line", [block(["a\n\u00a0b\n\u3000c"])]],
			[
				"a wrapped line that starts with a number",
				[block(["It was finished in\n2024. Then it shipped."])],
			],
			["an empty line", [block(["a\n\nb"])]],
			["a backslash at the end of a line", [block(["C:\\\nnext"])]],
			["emphasis across a line break", [block(["a ", ["b\nc", "em"], " d"])]],
			[
				"emphasis that holds underscores",
				[block([["my_var _ x", "em"], " and _a, ", ["b", "em"]])],
			],
			["list markers in a paragraph", [block(["- item\nmore\n\nthird\n2. z"])]],
			[
				"a paragraph after a list",
				[block(["Item"], { listItem: "bullet", level: 1 }), block(["Line one\n2. x"])],
			],
		])("keeps %s through a round trip", (_label, blocks) => {
			expect(shapeOf(roundTrip(blocks))).toEqual(shapeOf(blocks));
		});

		it("keeps the text of inline code that spans a line break", () => {
			const blocks = roundTrip([block(["x ", ["a\n# b\n\n- c", "code"]])]);
			expect(shapeOf(blocks)).toEqual(
				shapeOf([block(["x ", ["a", "code"], "\n", ["# b", "code"], "\n\n", ["- c", "code"]])]),
			);
		});

		it("keeps emphasis and a backslash at its end when whitespace follows inside the span", () => {
			const blocks = roundTrip([block(["a ", ["C:\\ ", "em"], "b"])]);
			expect(shapeOf(blocks)).toEqual(shapeOf([block(["a ", ["C:\\", "em"], " b"])]));
		});

		it.each<Child[][]>([
			[["un", ["believ", "em"], "able"]],
			[["Re", ["read this", "em"], "now"]],
			[["Re", ["read this", "em"], " now"]],
			[["Go ", ["read this", "em"], "now"]],
			[["x", ["y * z", "em"], "w"]],
			[["𠮷", ["x", "em"]]],
			[[["x", "em"], "𠮷"]],
			[
				[
					["a", "em"],
					["b", "strong"],
				],
			],
		])("preserves emphasis in %j", (children) => {
			const blocks = [block(children)];
			expect(shapeOf(roundTrip(blocks))).toEqual(shapeOf(blocks));
		});

		it("keeps emphasis next to a word across an empty span", () => {
			const blocks = roundTrip([block(["un", "", ["believ", "em"], "", "able"])]);
			expect(shapeOf(blocks)).toEqual(shapeOf([block(["un", ["believ", "em"], "able"])]));
		});

		it("moves whitespace at the edges of emphasis outside it", () => {
			const md = portableTextToMarkdown([
				block(["Re", [" read this ", "em"], "now", [" ", "em"], "!"]),
			]);
			expect(md).toBe("Re _read this_ now !\n");
			expect(spansOf(markdownToPortableText(md)[0]!)).toEqual([
				["Re ", []],
				["read this", ["em"]],
				[" now !", []],
			]);
		});

		it("leaves asterisks and underscores that cannot be emphasis unescaped", () => {
			expect(portableTextToMarkdown([block(["2 * 3 for user_id and a _ b"])])).toBe(
				"2 * 3 for user_id and a _ b\n",
			);
		});

		it.each([
			["a blockquote", [block(["a\nb\nc"], { style: "blockquote" })], ["a", "b\nc"]],
			["a heading", [block(["a\nb\nc"], { style: "h2" })], ["a", "b\nc"]],
			["a list item", [block(["a\nb\nc"], { listItem: "bullet", level: 1 })], ["a", "b\nc"]],
			[
				"a list item before a paragraph",
				[block(["Item\nmore"], { listItem: "bullet", level: 1 }), block(["Line one\n2. x"])],
				["Item", "more", "Line one\n2. x"],
			],
			["a paragraph that ends in line breaks", [block(["a\n\n"])], ["a"]],
			["lines that hold only a block marker", [block(["# \n- \n1. \nx"])], ["# \n- \n1. \nx"]],
		])("reads back the line breaks in %s", (_label, blocks, texts) => {
			expect(roundTrip(blocks).map((b) => b.children[0]!.text)).toEqual(texts);
		});
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
