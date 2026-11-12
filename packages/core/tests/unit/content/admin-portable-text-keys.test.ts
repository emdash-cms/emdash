import {
	prosemirrorToPortableText,
	type PortableTextBlock,
} from "@emdash-cms/admin/internal/portable-text";
import { describe, expect, it } from "vitest";

type Mark = { type: string; attrs?: Record<string, unknown> };
type Node = {
	type: string;
	attrs?: Record<string, unknown>;
	content?: Node[];
	marks?: Mark[];
	text?: string;
};

const KEY = "emdashPortableTextKey";

const text = (value: string, marks: Mark[] = []): Node => ({ type: "text", text: value, marks });
const link = (href: string): Mark => ({ type: "link", attrs: { href, target: null } });
const span = (key: string): Mark => ({
	type: "emdashPortableTextSpan",
	attrs: { key, markDefs: [] },
});
const paragraph = (key: string | undefined, ...content: Node[]): Node => ({
	type: "paragraph",
	attrs: key ? { [KEY]: key } : {},
	content,
});
const doc = (...content: Node[]) => ({ type: "doc", content });

type Keyed = { _key: string };
const keysOf = (items: unknown): string[] =>
	Array.isArray(items) ? items.map((item: Keyed) => item._key) : [];
const field = (block: PortableTextBlock, name: string): unknown =>
	(block as Record<string, unknown>)[name];
const textOf = (block: PortableTextBlock) =>
	(field(block, "children") as Array<{ text: string }>).map((child) => child.text).join("");

/** Every node and nested part with no key, or the key of another. */
const unkeyed = doc(
	paragraph(undefined, text("Plain "), text("linked", [link("https://example.com")])),
	paragraph("shared", text("First holder")),
	paragraph("shared", text("Second holder")),
	paragraph(
		"spans",
		text("one", [span("same")]),
		text("two", [{ type: "bold" }, span("same")]),
		text("three", [link("https://a.example")]),
		text("four", [link("https://b.example")]),
	),
	{ type: "heading", attrs: { level: 2 }, content: [text("Heading")] },
	{
		type: "bulletList",
		content: [
			{
				type: "listItem",
				content: [
					paragraph(undefined, text("Item")),
					{
						type: "orderedList",
						content: [{ type: "listItem", content: [paragraph(undefined, text("Nested"))] }],
					},
				],
			},
			{ type: "listItem", content: [paragraph(undefined, text("Second item"))] },
		],
	},
	{
		type: "blockquote",
		content: [paragraph(undefined, text("Quote")), paragraph(undefined, text("Quote again"))],
	},
	{
		type: "gallery",
		attrs: {
			images: [
				{ asset: { _ref: "one" } },
				{ _key: "image", asset: { _ref: "two" } },
				{ _key: "image", asset: { _ref: "three" } },
			],
		},
	},
	{
		type: "table",
		content: [
			{
				type: "tableRow",
				content: [
					{ type: "tableCell", content: [paragraph(undefined, text("Cell", [link("/cell")]))] },
					{ type: "tableCell", content: [paragraph(undefined, text("Other"))] },
				],
			},
		],
	},
	{ type: "pluginBlock", attrs: { blockType: "embed", id: "https://youtu.be/x", data: {} } },
	{ type: "codeBlock", attrs: { language: "js" }, content: [text("let a;")] },
	{ type: "horizontalRule" },
);

describe("admin Portable Text keys", () => {
	it("serializes one document to the same Portable Text every time", () => {
		expect(prosemirrorToPortableText(unkeyed)).toEqual(prosemirrorToPortableText(unkeyed));
	});

	it("gives every block, span, mark definition and image a key of its own", () => {
		const blocks = prosemirrorToPortableText(unkeyed);
		const unique = (keys: string[]) => expect(new Set(keys).size).toBe(keys.length);

		unique(keysOf(blocks));
		for (const block of blocks) {
			unique(keysOf(field(block, "children")));
			unique(keysOf(field(block, "markDefs")));
			unique(keysOf(field(block, "images")));
		}
		const table = blocks.find((block) => block._type === "table")!;
		const rows = field(table, "rows") as Array<{ _key: string; cells: unknown[] }>;
		unique([...keysOf(rows), ...rows.flatMap((row) => keysOf(row.cells))]);
		for (const cell of rows.flatMap((row) => row.cells) as Array<Record<string, unknown>>) {
			unique(keysOf(cell.content));
			unique(keysOf(cell.markDefs));
		}
	});

	it("leaves a key with its first holder", () => {
		const blocks = prosemirrorToPortableText(unkeyed);

		expect(blocks.find((block) => textOf(block) === "First holder")?._key).toBe("shared");
		expect(blocks.find((block) => textOf(block) === "Second holder")?._key).not.toBe("shared");
		const spans = blocks.find((block) => block._key === "spans")!;
		expect(keysOf(field(spans, "children"))[0]).toBe("same");
		const gallery = blocks.find((block) => block._type === "gallery")!;
		expect(keysOf(field(gallery, "images"))[1]).toBe("image");
	});

	it("keeps a block's span and link keys when a block is inserted above it", () => {
		const linked = paragraph("linked", text("Read "), text("this", [link("https://example.com")]));
		const [before] = prosemirrorToPortableText(doc(linked));
		const [, after] = prosemirrorToPortableText(doc(paragraph(undefined, text("New")), linked));

		expect(after).toEqual(before);
	});

	it("never gives a block a key that a later block holds", () => {
		const [saved] = prosemirrorToPortableText(doc(paragraph(undefined, text("Saved"))));
		const reloaded = paragraph(saved!._key, text("Saved"));
		const [added, kept] = prosemirrorToPortableText(
			doc(paragraph(undefined, text("Added")), reloaded),
		);

		expect(kept!._key).toBe(saved!._key);
		expect(added!._key).not.toBe(saved!._key);
	});
});
