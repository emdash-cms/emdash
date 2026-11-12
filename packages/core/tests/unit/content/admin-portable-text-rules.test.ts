import {
	portableTextToProsemirror,
	prosemirrorToPortableText,
	type PortableTextBlock,
} from "@emdash-cms/admin/internal/portable-text";
import { describe, expect, it } from "vitest";

import {
	roundTripThroughConverter,
	roundTripThroughSharedDocument,
} from "../../utils/admin-portable-text-round-trip.js";

type Mark = { type: string; attrs?: Record<string, unknown> };
type Node = {
	type: string;
	attrs?: Record<string, unknown>;
	content?: Node[];
	marks?: Mark[];
	text?: string;
};

const KEY = "emdashPortableTextKey";

const spanMark = (key: string): Mark => ({
	type: "emdashPortableTextSpan",
	attrs: { key, markDefs: [] },
});
const text = (value: string, marks: Mark[] = []): Node => ({ type: "text", text: value, marks });
const paragraph = (key: string, ...content: Node[]): Node => ({
	type: "paragraph",
	attrs: { [KEY]: key },
	content,
});
const keyedParagraph = (key: string, value: string) =>
	paragraph(key, text(value, [spanMark(`${key}-s`)]));
const listItem = (...content: Node[]): Node => ({ type: "listItem", content });
const doc = (...content: Node[]) => ({ type: "doc", content });

const listBlock = (
	key: string,
	type: "bullet" | "number",
	level: number,
	list?: { listId: string; listStart: number },
): PortableTextBlock => ({
	_type: "block",
	_key: key,
	style: "normal",
	listItem: type,
	level,
	...list,
	children: [{ _type: "span", _key: `${key}-s`, text: key }],
});

const tableOf = (...cells: Node[]): Node => ({
	type: "table",
	attrs: { emdashKey: "t" },
	content: [{ type: "tableRow", ...(cells.length > 0 ? { content: cells } : {}) }],
});
const cell = (...content: Node[]): Node => ({
	type: "tableCell",
	attrs: { colspan: 1, rowspan: 1, colwidth: null },
	...(content.length > 0 ? { content } : {}),
});

describe("admin Portable Text converter rules", () => {
	describe("a list item that starts with a nested list", () => {
		const cases: Array<{ name: string; blocks: PortableTextBlock[] }> = [
			{
				name: "bullets",
				blocks: [listBlock("a", "bullet", 2), listBlock("b", "bullet", 1)],
			},
			{
				name: "numbers",
				blocks: [
					listBlock("a", "number", 2, { listId: "nested", listStart: 1 }),
					listBlock("b", "number", 1, { listId: "outer", listStart: 1 }),
				],
			},
			{
				name: "a deeper list",
				blocks: [
					listBlock("a", "bullet", 3),
					listBlock("b", "bullet", 2),
					listBlock("c", "bullet", 1),
				],
			},
			{
				name: "a nested item's own nested list",
				blocks: [
					listBlock("a", "bullet", 1),
					listBlock("b", "number", 3, { listId: "deep", listStart: 1 }),
					listBlock("c", "bullet", 2),
				],
			},
			{
				name: "a nested list alone",
				blocks: [listBlock("a", "number", 2, { listId: "nested", listStart: 1 })],
			},
		];

		it.each(cases)("keeps $name unchanged", ({ blocks }) => {
			expect(roundTripThroughConverter(blocks)).toEqual(blocks);
			expect(roundTripThroughSharedDocument(blocks)).toEqual(blocks);
		});

		it("keeps the levels a merged list item saves", () => {
			const merged = doc({
				type: "bulletList",
				content: [
					listItem(
						{ type: "bulletList", content: [listItem(keyedParagraph("a", "a"))] },
						keyedParagraph("b", "b"),
					),
				],
			});
			const saved = prosemirrorToPortableText(merged);

			expect(saved).toEqual([listBlock("a", "bullet", 2), listBlock("b", "bullet", 1)]);
			expect(roundTripThroughSharedDocument(saved)).toEqual(saved);
		});
	});

	describe("empty containers", () => {
		const after = keyedParagraph("after", "after");
		const saved = prosemirrorToPortableText(doc(after));

		it.each([
			{ name: "list", node: { type: "bulletList" } },
			{ name: "numbered list", node: { type: "orderedList", attrs: { listId: "x" } } },
			{ name: "list item", node: { type: "bulletList", content: [listItem()] } },
			{ name: "quote", node: { type: "blockquote" } },
			{ name: "table", node: { type: "table", attrs: { emdashKey: "t" } } },
			{ name: "table with an empty row", node: tableOf() },
		])("drops an empty $name", ({ node }) => {
			expect(prosemirrorToPortableText(doc(node, after))).toEqual(saved);
		});

		it("saves a cell left without a paragraph like an empty cell", () => {
			const empty = prosemirrorToPortableText(doc(tableOf(cell(), cell(keyedParagraph("x", "x")))));
			const emptyParagraph = prosemirrorToPortableText(
				doc(tableOf(cell({ type: "paragraph" }), cell(keyedParagraph("x", "x")))),
			);

			expect(empty).toEqual(emptyParagraph);
		});

		it("saves a table whose second row a rowspan covers", () => {
			const spanning: Node = {
				type: "tableCell",
				attrs: { colspan: 1, rowspan: 2, colwidth: null },
				content: [{ type: "paragraph", content: [text("tall")] }],
			};
			const table: Node = {
				type: "table",
				attrs: { emdashKey: "t" },
				content: [{ type: "tableRow", content: [spanning] }, { type: "tableRow" }],
			};
			const blocks = prosemirrorToPortableText(doc(table));

			expect(
				(blocks[0] as { rows: Array<{ cells: Array<{ rowspan?: number }> }> }).rows.map((row) =>
					row.cells.map((tableCell) => tableCell.rowspan),
				),
			).toEqual([[2], []]);
			expect(roundTripThroughSharedDocument(blocks)).toEqual(blocks);
		});
	});

	describe("links that hold the same definition key", () => {
		const link = (href: string): Mark => ({ type: "link", attrs: { href, target: null } });
		const linkSpan = (key: string, href: string): Mark => ({
			type: "emdashPortableTextSpan",
			attrs: { key, markDefs: [{ _type: "link", _key: "link1", href }] },
		});
		const linked = (blocks: PortableTextBlock[]) => {
			const block = blocks[0] as {
				children: Array<{ text: string; marks?: string[] }>;
				markDefs: Array<{ _key: string; href: string }>;
			};
			return block.children.map((span) => ({
				text: span.text,
				href: block.markDefs.find((markDef) => span.marks?.includes(markDef._key))?.href,
			}));
		};

		it("keeps each link's destination when they point to different places", () => {
			const saved = prosemirrorToPortableText(
				doc(
					paragraph(
						"p",
						text("first", [link("https://a.example"), linkSpan("s1", "https://a.example")]),
						text(" and "),
						text("second", [link("https://b.example"), linkSpan("s2", "https://a.example")]),
					),
				),
			);

			expect(linked(saved)).toEqual([
				{ text: "first", href: "https://a.example" },
				{ text: " and ", href: undefined },
				{ text: "second", href: "https://b.example" },
			]);
			expect(roundTripThroughSharedDocument(saved)).toEqual(saved);
		});

		it("keeps one definition when they still point to the same place", () => {
			const saved = prosemirrorToPortableText(
				doc(
					paragraph(
						"p",
						text("first", [link("https://a.example"), linkSpan("s1", "https://a.example")]),
						text(" and "),
						text("second", [link("https://a.example"), linkSpan("s2", "https://a.example")]),
					),
				),
			);

			expect((saved[0] as { markDefs: unknown[] }).markDefs).toEqual([
				{ _type: "link", _key: "link1", href: "https://a.example" },
			]);
		});
	});

	describe("a table cell of several paragraphs", () => {
		const cellParagraph = (value: string): Node => ({ type: "paragraph", content: [text(value)] });
		const cellsOf = (blocks: PortableTextBlock[]) =>
			(
				blocks[0] as {
					rows: Array<{ cells: Array<{ content: Array<{ _key: string; text: string }> }> }>;
				}
			).rows.flatMap((row) => row.cells);

		it("keeps its span keys unique when it gets another paragraph after a save", () => {
			const saved = prosemirrorToPortableText(
				doc(tableOf(cell(cellParagraph("a"), cellParagraph("b")))),
			);
			const loaded = portableTextToProsemirror(saved) as Node;
			loaded.content![0]!.content![0]!.content![0]!.content!.push(cellParagraph("e"));
			const edited = prosemirrorToPortableText(loaded);

			const cells = cellsOf(edited);
			expect(cells[0]!.content.map((span) => span.text).join("")).toBe("a\nb\ne");
			for (const { content } of cells) {
				const keys = content.map((span) => span._key);
				expect(new Set(keys).size).toBe(keys.length);
			}
			expect(roundTripThroughConverter(saved)).toEqual(saved);
			expect(roundTripThroughConverter(edited)).toEqual(edited);
			expect(roundTripThroughSharedDocument(edited)).toEqual(edited);
		});
	});

	it("keeps subscript when a span has superscript too", () => {
		const marks = (blocks: PortableTextBlock[]) =>
			(blocks[0] as { children: Array<{ marks?: string[] }> }).children[0]?.marks;
		const subscript = { type: "subscript" };
		const superscript = { type: "superscript" };

		expect(
			marks(prosemirrorToPortableText(doc(paragraph("p", text("x", [subscript, superscript]))))),
		).toEqual(["subscript"]);
		expect(
			marks(prosemirrorToPortableText(doc(paragraph("p", text("x", [superscript, subscript]))))),
		).toEqual(["subscript"]);
	});

	it("keeps the span key a line break's span mark holds", () => {
		const blocks = prosemirrorToPortableText(
			doc(
				paragraph(
					"p",
					{ type: "hardBreak", marks: [spanMark("s")] },
					text("after a break", [spanMark("s")]),
				),
			),
		);

		expect(blocks).toEqual([
			{
				_type: "block",
				_key: "p",
				style: "normal",
				children: [{ _type: "span", _key: "s", text: "\nafter a break" }],
			},
		]);
	});
});
