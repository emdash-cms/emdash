/**
 * Admin Editor cssClasses Conversion Tests
 *
 * Mirrors `tests/unit/components/inline-editor-converters.test.ts` (inline
 * editor) and `tests/unit/converters/css-classes.test.ts` (core converters)
 * to lock down parity between the three independent converter implementations.
 *
 * Without this file, the admin editor's local converters in
 * `PortableTextEditor.tsx` are only exercised by the plugin-block tests, so
 * cssClasses regressions would slip through review.
 */

import { describe, it, expect } from "vitest";

import {
	_prosemirrorToPortableText as prosemirrorToPortableText,
	_portableTextToProsemirror as portableTextToProsemirror,
} from "../../src/components/PortableTextEditor";

const WS_RE = /\s+/;
const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortTokens = (s: string | undefined): string[] =>
	(s ?? "").split(WS_RE).filter(Boolean).toSorted(compareStrings);

type AnyBlock = { _type: string; cssClasses?: string; [k: string]: unknown };

describe("admin editor: block-level cssClasses round trip", () => {
	it("preserves a paragraph cssClasses on PM → PT and back", () => {
		const doc = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					attrs: { cssClasses: "lead" },
					content: [{ type: "text", text: "Hello" }],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as AnyBlock[];
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.cssClasses).toBe("lead");

		const back = portableTextToProsemirror(blocks);
		const para = back.content[0] as { type: string; attrs?: { cssClasses?: string } };
		expect(para.type).toBe("paragraph");
		expect(para.attrs?.cssClasses).toBe("lead");
	});

	it("merges blockquote and inner paragraph cssClasses (PM → PT)", () => {
		const doc = {
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

		const blocks = prosemirrorToPortableText(doc) as AnyBlock[];
		expect(blocks).toHaveLength(1);
		expect(sortTokens(blocks[0]?.cssClasses)).toEqual(["card", "lead"]);
	});

	it("propagates blockquote cssClasses to every paragraph child", () => {
		const doc = {
			type: "doc",
			content: [
				{
					type: "blockquote",
					attrs: { cssClasses: "card" },
					content: [
						{ type: "paragraph", content: [{ type: "text", text: "First" }] },
						{ type: "paragraph", content: [{ type: "text", text: "Second" }] },
					],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as AnyBlock[];
		expect(blocks).toHaveLength(2);
		expect(blocks[0]?.cssClasses).toBe("card");
		expect(blocks[1]?.cssClasses).toBe("card");
	});

	it("round-trips a styled blockquote: cssClasses end up on the blockquote node", () => {
		// This is the case the recent BlockStyleExtension fix targets — after
		// save/reload, classes must live on the blockquote node (where the
		// resolver now also targets), not the inner paragraph.
		const doc = {
			type: "doc",
			content: [
				{
					type: "blockquote",
					attrs: { cssClasses: "card" },
					content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc);
		const back = portableTextToProsemirror(blocks);
		const bq = back.content[0] as {
			type: string;
			attrs?: { cssClasses?: string };
			content?: Array<{ type: string; attrs?: { cssClasses?: string } }>;
		};
		expect(bq.type).toBe("blockquote");
		expect(bq.attrs?.cssClasses).toBe("card");
		expect(bq.content?.[0]?.type).toBe("paragraph");
		// The inner paragraph must NOT carry the class — otherwise it would
		// drift on subsequent toggles via the toolbar.
		expect(bq.content?.[0]?.attrs?.cssClasses).toBeUndefined();
	});

	it("preserves listItem cssClasses on PM → PT and PT → PM", () => {
		const doc = {
			type: "doc",
			content: [
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							attrs: { cssClasses: "checked" },
							content: [{ type: "paragraph", content: [{ type: "text", text: "Done" }] }],
						},
						{
							type: "listItem",
							content: [{ type: "paragraph", content: [{ type: "text", text: "Pending" }] }],
						},
					],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as AnyBlock[];
		expect(blocks).toHaveLength(2);
		expect(blocks[0]?.cssClasses).toBe("checked");
		expect(blocks[1]?.cssClasses).toBeUndefined();

		const back = portableTextToProsemirror(blocks);
		const list = back.content[0] as {
			type: string;
			content?: Array<{ type: string; attrs?: { cssClasses?: string } }>;
		};
		expect(list.type).toBe("bulletList");
		expect(list.content?.[0]?.attrs?.cssClasses).toBe("checked");
		expect(list.content?.[1]?.attrs?.cssClasses).toBeUndefined();
	});

	it("merges listItem cssClasses with inner paragraph cssClasses", () => {
		const doc = {
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

		const blocks = prosemirrorToPortableText(doc) as AnyBlock[];
		expect(blocks).toHaveLength(1);
		expect(sortTokens(blocks[0]?.cssClasses)).toEqual(["checked", "muted"]);
	});

	it("preserves image cssClasses through PM → PT → PM", () => {
		const doc = {
			type: "doc",
			content: [
				{
					type: "image",
					attrs: {
						src: "https://example.com/photo.jpg",
						mediaId: "med_admin_1",
						alt: "Hero",
						cssClasses: "rounded-2xl shadow-xl",
					},
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as AnyBlock[];
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?._type).toBe("image");
		expect(blocks[0]?.cssClasses).toBe("rounded-2xl shadow-xl");

		const back = portableTextToProsemirror(blocks);
		const node = back.content[0] as { type: string; attrs?: { cssClasses?: string } };
		expect(node.type).toBe("image");
		expect(node.attrs?.cssClasses).toBe("rounded-2xl shadow-xl");
	});

	it("preserves codeBlock cssClasses through PM → PT → PM", () => {
		// codeBlock is in STYLED_BLOCK_TYPES so the toolbar can apply classes,
		// but PortableTextCodeBlock doesn't list cssClasses in its TS shape —
		// runtime preservation must still work via the wrapper.
		const doc = {
			type: "doc",
			content: [
				{
					type: "codeBlock",
					attrs: { language: "ts", cssClasses: "code-callout" },
					content: [{ type: "text", text: "const x = 1;" }],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as AnyBlock[];
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?._type).toBe("code");
		expect(blocks[0]?.cssClasses).toBe("code-callout");

		const back = portableTextToProsemirror(blocks);
		const node = back.content[0] as { type: string; attrs?: { cssClasses?: string } };
		expect(node.type).toBe("codeBlock");
		expect(node.attrs?.cssClasses).toBe("code-callout");
	});

	it("preserves horizontalRule variant + cssClasses round trip", () => {
		const doc = {
			type: "doc",
			content: [
				{
					type: "horizontalRule",
					attrs: { variant: "dots", cssClasses: "section-divider" },
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as AnyBlock[];
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?._type).toBe("break");
		expect((blocks[0] as { variant?: string }).variant).toBe("dots");
		expect(blocks[0]?.cssClasses).toBe("section-divider");

		const back = portableTextToProsemirror(blocks);
		const node = back.content[0] as {
			type: string;
			attrs?: { variant?: string; cssClasses?: string };
		};
		expect(node.type).toBe("horizontalRule");
		expect(node.attrs?.variant).toBe("dots");
		expect(node.attrs?.cssClasses).toBe("section-divider");
	});

	it("does not set cssClasses when the source has none", () => {
		const doc = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [{ type: "text", text: "Plain" }],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as AnyBlock[];
		expect(blocks[0]?.cssClasses).toBeUndefined();
	});
});

describe("admin editor: cssClass mark round trip", () => {
	it("PM → PT serializes a cssClass mark as a markDef", () => {
		const doc = {
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

		const blocks = prosemirrorToPortableText(doc) as Array<{
			markDefs?: Array<{ _type: string; _key: string; classes?: string }>;
			children: Array<{ marks?: string[] }>;
		}>;
		expect(blocks).toHaveLength(1);
		const block = blocks[0]!;
		expect(block.markDefs).toHaveLength(1);
		expect(block.markDefs?.[0]?._type).toBe("cssClass");
		expect(block.markDefs?.[0]?.classes).toBe("highlight-yellow");
		expect(block.children[0]?.marks).toEqual([block.markDefs?.[0]?._key]);
	});

	it("dedupes cssClass markDefs when the same classes appear twice", () => {
		const doc = {
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

		const blocks = prosemirrorToPortableText(doc) as Array<{
			markDefs?: Array<{ _key: string }>;
			children: Array<{ marks?: string[] }>;
		}>;
		const block = blocks[0]!;
		expect(block.markDefs).toHaveLength(1);
		const key = block.markDefs?.[0]?._key;
		const styled = block.children.filter((s) => s.marks?.includes(key as string));
		expect(styled).toHaveLength(2);
	});

	it("PT → PM converts a cssClass markDef into a cssClass mark", () => {
		const ptBlocks = [
			{
				_type: "block",
				_key: "b1",
				style: "normal",
				markDefs: [{ _type: "cssClass", _key: "m1", classes: "highlight-yellow" }],
				children: [{ _type: "span", _key: "s1", text: "highlighted", marks: ["m1"] }],
			},
		] as unknown as Parameters<typeof portableTextToProsemirror>[0];

		const pm = portableTextToProsemirror(ptBlocks);
		const para = pm.content[0] as { type: string; content?: Array<{ marks?: unknown }> };
		expect(para.type).toBe("paragraph");
		expect(para.content?.[0]?.marks).toEqual([
			{ type: "cssClass", attrs: { classes: "highlight-yellow" } },
		]);
	});

	it("does not collide a link href with a cssClass classes string sharing text", () => {
		// Regression: namespacing markDefMap keys as `link:${href}` /
		// `cssClass:${classes}` keeps these distinct even when their raw
		// strings overlap. See css-classes.test.ts for the core counterpart.
		const doc = {
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

		const blocks = prosemirrorToPortableText(doc) as Array<{
			markDefs?: Array<{ _type: string }>;
		}>;
		const defs = blocks[0]?.markDefs ?? [];
		expect(defs).toHaveLength(2);
		const types = defs.map((d) => d._type).toSorted(compareStrings);
		expect(types).toEqual(["cssClass", "link"]);
	});

	it("PM → PT drops a whitespace-only cssClass mark", () => {
		const doc = {
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

		const blocks = prosemirrorToPortableText(doc) as Array<{
			markDefs?: Array<unknown>;
			children: Array<{ marks?: string[] }>;
		}>;
		expect(blocks[0]?.markDefs ?? []).toHaveLength(0);
		expect(blocks[0]?.children[0]?.marks ?? []).toHaveLength(0);
	});

	it("PM → PT trims padding from a cssClass mark before persisting", () => {
		const doc = {
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

		const blocks = prosemirrorToPortableText(doc) as Array<{
			markDefs?: Array<{ classes?: string }>;
		}>;
		expect(blocks[0]?.markDefs?.[0]?.classes).toBe("highlight-yellow");
	});

	it("PM → PT collapses padded variants of the same classes into one markDef", () => {
		const doc = {
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
							marks: [{ type: "cssClass", attrs: { classes: "  hl  " } }],
						},
					],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as Array<{
			markDefs?: Array<{ _key: string }>;
			children: Array<{ marks?: string[] }>;
		}>;
		const block = blocks[0]!;
		expect(block.markDefs).toHaveLength(1);
		const key = block.markDefs?.[0]?._key;
		const styled = block.children.filter((s) => s.marks?.includes(key as string));
		expect(styled).toHaveLength(2);
	});

	it("PT → PM ignores a whitespace-only block-level cssClasses", () => {
		const ptBlocks = [
			{
				_type: "block",
				_key: "b1",
				style: "normal",
				cssClasses: "   ",
				markDefs: [],
				children: [{ _type: "span", _key: "s1", text: "plain", marks: [] }],
			},
		] as unknown as Parameters<typeof portableTextToProsemirror>[0];

		const pm = portableTextToProsemirror(ptBlocks);
		const para = pm.content[0] as { attrs?: { cssClasses?: string } };
		expect(para.attrs?.cssClasses).toBeUndefined();
	});

	it("round-trips a padded block-level cssClasses as the trimmed value", () => {
		const doc = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					attrs: { cssClasses: "  lead  " },
					content: [{ type: "text", text: "Hello" }],
				},
			],
		};

		const blocks = prosemirrorToPortableText(doc) as Array<{ cssClasses?: string }>;
		expect(blocks[0]?.cssClasses).toBe("lead");

		const pm = portableTextToProsemirror(
			blocks as unknown as Parameters<typeof portableTextToProsemirror>[0],
		);
		const para = pm.content[0] as { attrs?: { cssClasses?: string } };
		expect(para.attrs?.cssClasses).toBe("lead");
	});
});
