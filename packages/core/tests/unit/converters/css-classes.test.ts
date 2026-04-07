import { describe, it, expect } from "vitest";

import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type {
	ProseMirrorDocument,
	PortableTextTextBlock,
} from "../../../src/content/converters/types.js";

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
