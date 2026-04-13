/**
 * Verifies the InlinePortableTextEditor's local converters preserve
 * cssClasses (block-level) and cssClass marks (inline) through PM↔PT
 * round-trips. Without this, visual editing on the live site silently
 * strips all admin-applied styles on every save — a P0 data-loss bug.
 */
import { describe, expect, it } from "vitest";

import {
	_pmToPortableText as pmToPortableText,
	_portableTextToPM as portableTextToPM,
} from "../../../src/components/InlinePortableTextEditor.js";

const WS_RE = /\s+/;
const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

describe("InlinePortableTextEditor converters: cssClasses round-trip", () => {
	it("preserves block-level cssClasses on a paragraph", () => {
		const pm = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					attrs: { cssClasses: "lead" },
					content: [{ type: "text", text: "Hello" }],
				},
			],
		};

		const blocks = pmToPortableText(pm);
		expect(blocks).toHaveLength(1);
		expect((blocks[0] as { cssClasses?: string }).cssClasses).toBe("lead");

		const back = portableTextToPM(blocks);
		expect(back.content?.[0]?.type).toBe("paragraph");
		expect(back.content?.[0]?.attrs?.cssClasses).toBe("lead");
	});

	it("merges blockquote and inner paragraph cssClasses", () => {
		const pm = {
			type: "doc",
			content: [
				{
					type: "blockquote",
					attrs: { cssClasses: "card" },
					content: [
						{
							type: "paragraph",
							attrs: { cssClasses: "lead" },
							content: [{ type: "text", text: "x" }],
						},
					],
				},
			],
		};

		const blocks = pmToPortableText(pm);
		expect(blocks).toHaveLength(1);
		const tokens = ((blocks[0] as { cssClasses?: string }).cssClasses ?? "")
			.split(WS_RE)
			.filter(Boolean)
			.toSorted(compareStrings);
		expect(tokens).toEqual(["card", "lead"]);
	});

	it("preserves listItem cssClasses round-trip", () => {
		const pm = {
			type: "doc",
			content: [
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							attrs: { cssClasses: "checked" },
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "Done" }],
								},
							],
						},
					],
				},
			],
		};

		const blocks = pmToPortableText(pm);
		expect(blocks).toHaveLength(1);
		expect((blocks[0] as { cssClasses?: string }).cssClasses).toBe("checked");

		const back = portableTextToPM(blocks);
		const list = back.content?.[0];
		expect(list?.type).toBe("bulletList");
		expect(list?.content?.[0]?.attrs?.cssClasses).toBe("checked");
	});

	it("preserves cssClass mark through PM → PT → PM", () => {
		const pm = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{
							type: "text",
							text: "highlighted",
							marks: [{ type: "cssClass", attrs: { classes: "highlight-yellow" } }],
						},
					],
				},
			],
		};

		const blocks = pmToPortableText(pm);
		const block = blocks[0] as {
			markDefs?: Array<{ _type: string; _key: string; classes?: string }>;
			children?: Array<{ marks?: string[] }>;
		};
		expect(block.markDefs).toHaveLength(1);
		expect(block.markDefs?.[0]?._type).toBe("cssClass");
		expect(block.markDefs?.[0]?.classes).toBe("highlight-yellow");
		expect(block.children?.[0]?.marks).toEqual([block.markDefs?.[0]?._key]);

		const back = portableTextToPM(blocks);
		const text = back.content?.[0]?.content?.[0];
		expect(text?.type).toBe("text");
		expect(text?.marks).toEqual([{ type: "cssClass", attrs: { classes: "highlight-yellow" } }]);
	});

	it("preserves image cssClasses through PM → PT → PM", () => {
		const pm = {
			type: "doc",
			content: [
				{
					type: "image",
					attrs: {
						src: "https://example.com/photo.jpg",
						mediaId: "med_inline_1",
						alt: "Inline test",
						cssClasses: "rounded-2xl shadow-xl",
					},
				},
			],
		};

		const blocks = pmToPortableText(pm);
		expect(blocks).toHaveLength(1);
		expect((blocks[0] as { _type: string; cssClasses?: string })._type).toBe("image");
		expect((blocks[0] as { cssClasses?: string }).cssClasses).toBe("rounded-2xl shadow-xl");

		const back = portableTextToPM(blocks);
		const node = back.content?.[0];
		expect(node?.type).toBe("image");
		expect(node?.attrs?.cssClasses).toBe("rounded-2xl shadow-xl");
	});

	it("dedupes cssClass markDefs when the same classes appear twice", () => {
		const pm = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{
							type: "text",
							text: "first ",
							marks: [{ type: "cssClass", attrs: { classes: "hl" } }],
						},
						{ type: "text", text: "middle " },
						{
							type: "text",
							text: "second",
							marks: [{ type: "cssClass", attrs: { classes: "hl" } }],
						},
					],
				},
			],
		};

		const blocks = pmToPortableText(pm);
		const block = blocks[0] as {
			markDefs?: Array<{ _key: string }>;
			children?: Array<{ marks?: string[] }>;
		};
		expect(block.markDefs).toHaveLength(1);
		const key = block.markDefs?.[0]?._key;
		const styled = (block.children ?? []).filter((s) => s.marks?.includes(key as string));
		expect(styled).toHaveLength(2);
	});
});
