import { describe, it, expect } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import {
	mergeCssClasses,
	prosemirrorToPortableText,
} from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type {
	PortableTextBlock,
	PortableTextTextBlock,
	ProseMirrorDocument,
} from "../../../src/content/converters/types.js";

const WS_RE = /\s+/;
const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortTokens = (s: string | undefined): string[] =>
	(s ?? "").split(WS_RE).filter(Boolean).toSorted(compareStrings);

describe("cssClasses propagation through PM → PT", () => {
	it("applies cssClasses to every block produced from a styled blockquote", () => {
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "blockquote",
					attrs: { cssClasses: "card surface-deeper" },
					content: [
						{
							type: "paragraph",
							content: [{ type: "text", text: "First line" }],
						},
						{
							type: "paragraph",
							content: [{ type: "text", text: "Second line" }],
						},
						{
							type: "paragraph",
							content: [{ type: "text", text: "Third line" }],
						},
					],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as PortableTextTextBlock[];

		expect(blocks).toHaveLength(3);
		for (const block of blocks) {
			expect(block.style).toBe("blockquote");
			// cssClasses lives at the block level, applied to each block
			expect((block as PortableTextTextBlock & { cssClasses?: string }).cssClasses).toBe(
				"card surface-deeper",
			);
		}
	});

	it("applies cssClasses to a single converted paragraph", () => {
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					attrs: { cssClasses: "lead" },
					content: [{ type: "text", text: "Hello" }],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as PortableTextTextBlock[];
		expect(blocks).toHaveLength(1);
		expect((blocks[0] as PortableTextTextBlock & { cssClasses?: string }).cssClasses).toBe("lead");
	});

	it("round-trips a paragraph with cssClasses through PT → PM → PT", () => {
		const original: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					attrs: { cssClasses: "lead" },
					content: [{ type: "text", text: "Hello" }],
				},
			],
		};

		const blocks = prosemirrorToPortableText(original);
		const pm = portableTextToProsemirror(blocks);
		expect(pm.content).toHaveLength(1);
		expect(pm.content[0]?.type).toBe("paragraph");
		expect(pm.content[0]?.attrs?.cssClasses).toBe("lead");
	});

	it("does not set cssClasses when the source node has none", () => {
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [{ type: "text", text: "Plain" }],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc);
		expect(blocks).toHaveLength(1);
		expect(
			(blocks[0] as PortableTextTextBlock & { cssClasses?: string }).cssClasses,
		).toBeUndefined();
	});
});

describe("cssClass mark round-trip via markDefs", () => {
	it("PM → PT serializes a cssClass mark as a markDef referenced by the span", () => {
		const doc: ProseMirrorDocument = {
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

		const blocks = prosemirrorToPortableText(doc) as PortableTextTextBlock[];
		expect(blocks).toHaveLength(1);
		const block = blocks[0]!;
		expect(block.markDefs).toBeDefined();
		expect(block.markDefs).toHaveLength(1);

		const def = block.markDefs![0]!;
		expect(def._type).toBe("cssClass");
		expect((def as { classes: string }).classes).toBe("highlight-yellow");
		expect(typeof def._key).toBe("string");
		expect(def._key.length).toBeGreaterThan(0);

		expect(block.children).toHaveLength(1);
		expect(block.children[0]?.marks).toEqual([def._key]);
	});

	it("PM → PT deduplicates two text runs sharing the same cssClass mark", () => {
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{
							type: "text",
							text: "first ",
							marks: [{ type: "cssClass", attrs: { classes: "highlight-yellow" } }],
						},
						{ type: "text", text: "middle " },
						{
							type: "text",
							text: "second",
							marks: [{ type: "cssClass", attrs: { classes: "highlight-yellow" } }],
						},
					],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as PortableTextTextBlock[];
		const block = blocks[0]!;
		expect(block.markDefs).toHaveLength(1);
		const key = block.markDefs![0]!._key;

		const styledSpans = block.children.filter((s) => s.marks?.includes(key));
		expect(styledSpans).toHaveLength(2);
	});

	it("PT → PM converts a cssClass markDef into a cssClass mark on the text node", () => {
		const ptBlocks: PortableTextBlock[] = [
			{
				_type: "block",
				_key: "b1",
				style: "normal",
				markDefs: [{ _type: "cssClass", _key: "m1", classes: "highlight-yellow" }],
				children: [{ _type: "span", _key: "s1", text: "highlighted", marks: ["m1"] }],
			},
		];

		const pm = portableTextToProsemirror(ptBlocks);
		expect(pm.content).toHaveLength(1);
		const para = pm.content[0]!;
		expect(para.type).toBe("paragraph");
		expect(para.content).toHaveLength(1);
		const text = para.content![0]!;
		expect(text.type).toBe("text");
		expect(text.text).toBe("highlighted");
		expect(text.marks).toEqual([{ type: "cssClass", attrs: { classes: "highlight-yellow" } }]);
	});

	it("round-trips a cssClass mark through PT → PM → PT", () => {
		const ptBlocks: PortableTextBlock[] = [
			{
				_type: "block",
				_key: "b1",
				style: "normal",
				markDefs: [{ _type: "cssClass", _key: "m1", classes: "highlight-yellow" }],
				children: [{ _type: "span", _key: "s1", text: "highlighted", marks: ["m1"] }],
			},
		];

		const pm = portableTextToProsemirror(ptBlocks);
		const roundTripped = prosemirrorToPortableText(pm) as PortableTextTextBlock[];
		expect(roundTripped).toHaveLength(1);
		const block = roundTripped[0]!;
		expect(block.markDefs).toHaveLength(1);
		const def = block.markDefs![0]!;
		expect(def._type).toBe("cssClass");
		expect((def as { classes: string }).classes).toBe("highlight-yellow");
		expect(block.children).toHaveLength(1);
		expect(block.children[0]?.text).toBe("highlighted");
		expect(block.children[0]?.marks).toEqual([def._key]);
	});

	it("preserves multiple distinct cssClass marks on the same span", () => {
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{
							type: "text",
							text: "fancy",
							marks: [
								{ type: "cssClass", attrs: { classes: "highlight-yellow" } },
								{ type: "cssClass", attrs: { classes: "font-mono" } },
							],
						},
					],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as PortableTextTextBlock[];
		const block = blocks[0]!;
		expect(block.markDefs).toHaveLength(2);

		const classesByKey = new Map(
			(block.markDefs ?? []).map((d) => [d._key, (d as { classes: string }).classes]),
		);
		const spanMarks = block.children[0]?.marks ?? [];
		expect(spanMarks).toHaveLength(2);
		expect(spanMarks.map((k) => classesByKey.get(k)).toSorted(compareStrings)).toEqual(
			["font-mono", "highlight-yellow"].toSorted(compareStrings),
		);

		// Round-trip preserves both marks
		const pm = portableTextToProsemirror(blocks);
		const roundTripped = prosemirrorToPortableText(pm) as PortableTextTextBlock[];
		expect(roundTripped[0]?.markDefs).toHaveLength(2);
	});

	it("PM → PT drops a whitespace-only cssClass mark", () => {
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{
							type: "text",
							text: "plain",
							marks: [{ type: "cssClass", attrs: { classes: "   " } }],
						},
					],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as PortableTextTextBlock[];
		expect(blocks).toHaveLength(1);
		const block = blocks[0]!;
		expect(block.markDefs ?? []).toHaveLength(0);
		expect(block.children).toHaveLength(1);
		expect(block.children[0]?.text).toBe("plain");
		expect(block.children[0]?.marks ?? []).toHaveLength(0);
	});

	it("PM → PT trims padding from a cssClass mark before persisting", () => {
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{
							type: "text",
							text: "highlighted",
							marks: [{ type: "cssClass", attrs: { classes: "  highlight-yellow  " } }],
						},
					],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as PortableTextTextBlock[];
		const def = blocks[0]!.markDefs![0]!;
		expect((def as { classes: string }).classes).toBe("highlight-yellow");
	});

	it("PM → PT collapses padded variants of the same classes into a single markDef", () => {
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{
							type: "text",
							text: "first ",
							marks: [{ type: "cssClass", attrs: { classes: "highlight-yellow" } }],
						},
						{ type: "text", text: "middle " },
						{
							type: "text",
							text: "second",
							marks: [{ type: "cssClass", attrs: { classes: "  highlight-yellow  " } }],
						},
					],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as PortableTextTextBlock[];
		const block = blocks[0]!;
		expect(block.markDefs).toHaveLength(1);
		const key = block.markDefs![0]!._key;
		const styledSpans = block.children.filter((s) => s.marks?.includes(key));
		expect(styledSpans).toHaveLength(2);
	});

	it("PT → PM ignores a whitespace-only block-level cssClasses", () => {
		const ptBlocks: PortableTextBlock[] = [
			{
				_type: "block",
				_key: "b1",
				style: "normal",
				cssClasses: "   ",
				markDefs: [],
				children: [{ _type: "span", _key: "s1", text: "plain", marks: [] }],
			} as unknown as PortableTextBlock,
		];

		const pm = portableTextToProsemirror(ptBlocks);
		const para = pm.content[0]!;
		expect(para.attrs?.cssClasses).toBeUndefined();
	});

	it("round-trips a padded block-level cssClasses as the trimmed value", () => {
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					attrs: { cssClasses: "  lead  " },
					content: [{ type: "text", text: "Hello" }],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as PortableTextTextBlock[];
		expect((blocks[0] as { cssClasses?: string }).cssClasses).toBe("lead");

		const pm = portableTextToProsemirror(blocks);
		expect(pm.content[0]?.attrs?.cssClasses).toBe("lead");
	});
});

describe("nested cssClasses through PM ↔ PT", () => {
	it("preserves both blockquote-level and inner paragraph cssClasses (merged)", () => {
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "blockquote",
					attrs: { cssClasses: "card" },
					content: [
						{
							type: "paragraph",
							attrs: { cssClasses: "lead" },
							content: [{ type: "text", text: "Hello" }],
						},
					],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as PortableTextTextBlock[];
		expect(blocks).toHaveLength(1);
		const tokens = sortTokens(blocks[0]!.cssClasses);
		expect(tokens).toEqual(["card", "lead"]);
	});

	it("merges per-paragraph classes when multiple paragraphs live in one styled blockquote", () => {
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "blockquote",
					attrs: { cssClasses: "card" },
					content: [
						{
							type: "paragraph",
							attrs: { cssClasses: "lead" },
							content: [{ type: "text", text: "First" }],
						},
						{
							type: "paragraph",
							content: [{ type: "text", text: "Second" }],
						},
						{
							type: "paragraph",
							attrs: { cssClasses: "muted" },
							content: [{ type: "text", text: "Third" }],
						},
					],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as PortableTextTextBlock[];
		expect(blocks).toHaveLength(3);
		expect(sortTokens(blocks[0]!.cssClasses)).toEqual(["card", "lead"]);
		expect(blocks[1]!.cssClasses).toBe("card");
		expect(sortTokens(blocks[2]!.cssClasses)).toEqual(["card", "muted"]);
	});

	it("preserves listItem cssClasses through PM → PT and PT → PM", () => {
		const doc: ProseMirrorDocument = {
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
						{
							type: "listItem",
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "Pending" }],
								},
							],
						},
					],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as PortableTextTextBlock[];
		expect(blocks).toHaveLength(2);
		expect(blocks[0]!.cssClasses).toBe("checked");
		expect(blocks[1]!.cssClasses).toBeUndefined();

		// Round-trip back to PM
		const pm = portableTextToProsemirror(blocks);
		const list = pm.content[0]!;
		expect(list.type).toBe("bulletList");
		const items = list.content!;
		expect(items[0]?.attrs?.cssClasses).toBe("checked");
		expect(items[1]?.attrs?.cssClasses).toBeUndefined();
	});

	it("merges listItem cssClasses with inner paragraph cssClasses", () => {
		const doc: ProseMirrorDocument = {
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
									attrs: { cssClasses: "muted" },
									content: [{ type: "text", text: "Done & quiet" }],
								},
							],
						},
					],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as PortableTextTextBlock[];
		expect(blocks).toHaveLength(1);
		expect(sortTokens(blocks[0]!.cssClasses)).toEqual(["checked", "muted"]);
	});

	it("dedupes overlapping tokens during merge", () => {
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "blockquote",
					attrs: { cssClasses: "card surface-deeper" },
					content: [
						{
							type: "paragraph",
							attrs: { cssClasses: "card lead" },
							content: [{ type: "text", text: "x" }],
						},
					],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as PortableTextTextBlock[];
		const tokens = sortTokens(blocks[0]!.cssClasses);
		expect(tokens).toEqual(["card", "lead", "surface-deeper"]);
	});
});

describe("image cssClasses round-trip", () => {
	it("PM image with cssClasses serializes to a PT image block with cssClasses", () => {
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "image",
					attrs: {
						src: "https://example.com/photo.jpg",
						alt: "A photo",
						mediaId: "med_123",
						width: 1200,
						height: 800,
						cssClasses: "rounded-2xl shadow-xl",
					},
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc);
		expect(blocks).toHaveLength(1);
		const block = blocks[0]!;
		expect(block._type).toBe("image");
		expect((block as { cssClasses?: string }).cssClasses).toBe("rounded-2xl shadow-xl");
	});

	it("PT image block with cssClasses restores them on the PM image node attrs", () => {
		const ptBlocks: PortableTextBlock[] = [
			{
				_type: "image",
				_key: "img1",
				asset: { _ref: "med_123", url: "https://example.com/photo.jpg" },
				alt: "A photo",
				width: 1200,
				height: 800,
				cssClasses: "polaroid",
			},
		];

		const pm = portableTextToProsemirror(ptBlocks);
		expect(pm.content).toHaveLength(1);
		const node = pm.content[0]!;
		expect(node.type).toBe("image");
		expect(node.attrs?.cssClasses).toBe("polaroid");
	});

	it("round-trips image cssClasses through PM → PT → PM", () => {
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "image",
					attrs: {
						src: "https://example.com/photo.jpg",
						mediaId: "med_456",
						alt: "Round-trip test",
						cssClasses: "frame border-thick",
					},
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc);
		const pm = portableTextToProsemirror(blocks);
		expect(pm.content).toHaveLength(1);
		expect(pm.content[0]?.attrs?.cssClasses).toBe("frame border-thick");
	});

	it("preserves image cssClasses alongside text-block styles in the same document", () => {
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					attrs: { cssClasses: "lead" },
					content: [{ type: "text", text: "Intro paragraph" }],
				},
				{
					type: "image",
					attrs: {
						src: "https://example.com/photo.jpg",
						mediaId: "med_789",
						alt: "Hero",
						cssClasses: "rounded-xl",
					},
				},
				{
					type: "paragraph",
					content: [{ type: "text", text: "Body paragraph" }],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc);
		expect(blocks).toHaveLength(3);
		expect((blocks[0] as PortableTextTextBlock).cssClasses).toBe("lead");
		expect((blocks[1] as { cssClasses?: string }).cssClasses).toBe("rounded-xl");
		expect((blocks[2] as PortableTextTextBlock).cssClasses).toBeUndefined();
	});

	it("does not set cssClasses when the image has none", () => {
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "image",
					attrs: {
						src: "https://example.com/photo.jpg",
						mediaId: "med_000",
						alt: "Plain",
					},
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc);
		expect((blocks[0] as { cssClasses?: string }).cssClasses).toBeUndefined();
	});
});

describe("mergeCssClasses helper", () => {
	it("returns the other when one side is empty", () => {
		expect(mergeCssClasses(undefined, "a")).toBe("a");
		expect(mergeCssClasses("a", undefined)).toBe("a");
		expect(mergeCssClasses(undefined, undefined)).toBeUndefined();
		expect(mergeCssClasses("", "")).toBeUndefined();
	});

	it("dedupes tokens and preserves first-seen order", () => {
		expect(mergeCssClasses("a b", "b c")).toBe("a b c");
		expect(mergeCssClasses("  a   b  ", "b\tc")).toBe("a b c");
	});

	it("normalizes whitespace-only input to undefined", () => {
		// Regression: previously a whitespace-only string passed alongside
		// undefined was returned verbatim, leaking garbage into PT.
		expect(mergeCssClasses(undefined, "   ")).toBeUndefined();
		expect(mergeCssClasses("   ", undefined)).toBeUndefined();
		expect(mergeCssClasses("   ", "\t\n")).toBeUndefined();
		expect(mergeCssClasses("   ", "lead")).toBe("lead");
		expect(mergeCssClasses("lead", "   ")).toBe("lead");
	});
});

describe("markDef key collision regression", () => {
	it("does not collapse a link href and a cssClass classes string that share text", () => {
		// Pre-fix: markDefMap keyed link by raw href and cssClass by `cssClass:${classes}`,
		// so a link with href "cssClass:foo" would collide with a cssClass mark
		// {classes: "foo"}. After namespacing both as `link:${href}` and
		// `cssClass:${classes}`, they live in distinct map slots.
		const doc: ProseMirrorDocument = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{
							type: "text",
							text: "anchor",
							marks: [{ type: "link", attrs: { href: "cssClass:foo" } }],
						},
						{
							type: "text",
							text: " styled",
							marks: [{ type: "cssClass", attrs: { classes: "foo" } }],
						},
					],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as PortableTextTextBlock[];
		expect(blocks).toHaveLength(1);
		const defs = blocks[0]!.markDefs ?? [];
		// Two distinct markDefs, one link, one cssClass — never collapsed.
		expect(defs).toHaveLength(2);
		const types = defs.map((d) => d._type).toSorted(compareStrings);
		expect(types).toEqual(["cssClass", "link"]);
	});
});
