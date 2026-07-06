import { describe, it, expect } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type { PortableTextTextBlock } from "../../../src/content/converters/types.js";

describe("text-align round-trip (core converters)", () => {
	it("preserves center alignment on paragraphs through PM → PT → PM", () => {
		const pmDoc = {
			type: "doc" as const,
			content: [
				{
					type: "paragraph",
					attrs: { textAlign: "center" },
					content: [{ type: "text", text: "Centered text" }],
				},
			],
		};

		// PM → PT
		const pt = prosemirrorToPortableText(pmDoc);
		expect(pt).toHaveLength(1);
		const block = pt[0] as PortableTextTextBlock;
		expect(block._type).toBe("block");
		expect(block.style).toBe("normal");
		expect(block.textAlign).toBe("center");
		expect(block.children[0]?.text).toBe("Centered text");

		// PT → PM
		const restored = portableTextToProsemirror(pt);
		expect(restored.content[0]?.type).toBe("paragraph");
		expect(restored.content[0]?.attrs?.textAlign).toBe("center");
	});

	it("preserves right alignment on headings through PM → PT → PM", () => {
		const pmDoc = {
			type: "doc" as const,
			content: [
				{
					type: "heading",
					attrs: { level: 2, textAlign: "right" },
					content: [{ type: "text", text: "Right heading" }],
				},
			],
		};

		const pt = prosemirrorToPortableText(pmDoc);
		expect(pt).toHaveLength(1);
		const block = pt[0] as PortableTextTextBlock;
		expect(block._type).toBe("block");
		expect(block.style).toBe("h2");
		expect(block.textAlign).toBe("right");

		const restored = portableTextToProsemirror(pt);
		expect(restored.content[0]?.type).toBe("heading");
		expect(restored.content[0]?.attrs?.level).toBe(2);
		expect(restored.content[0]?.attrs?.textAlign).toBe("right");
	});

	it("does not persist 'left' alignment (TipTap default)", () => {
		const pmDoc = {
			type: "doc" as const,
			content: [
				{
					type: "paragraph",
					attrs: { textAlign: "left" },
					content: [{ type: "text", text: "Left text" }],
				},
			],
		};

		const pt = prosemirrorToPortableText(pmDoc);
		const block = pt[0] as PortableTextTextBlock;
		expect(block.textAlign).toBeUndefined();
	});

	it("preserves justify alignment", () => {
		const pmDoc = {
			type: "doc" as const,
			content: [
				{
					type: "paragraph",
					attrs: { textAlign: "justify" },
					content: [{ type: "text", text: "Justified text" }],
				},
			],
		};

		const pt = prosemirrorToPortableText(pmDoc);
		expect((pt[0] as PortableTextTextBlock).textAlign).toBe("justify");
		const restored = portableTextToProsemirror(pt);
		expect(restored.content[0]?.attrs?.textAlign).toBe("justify");
	});

	it("round-trips mixed alignment blocks", () => {
		const pmDoc = {
			type: "doc" as const,
			content: [
				{
					type: "paragraph",
					content: [{ type: "text", text: "Default" }],
				},
				{
					type: "heading",
					attrs: { level: 1, textAlign: "center" },
					content: [{ type: "text", text: "Center title" }],
				},
				{
					type: "paragraph",
					attrs: { textAlign: "right" },
					content: [{ type: "text", text: "Right paragraph" }],
				},
			],
		};

		const pt = prosemirrorToPortableText(pmDoc);
		const restored = portableTextToProsemirror(pt);

		expect(restored.content).toHaveLength(3);
		expect(restored.content[0]?.attrs?.textAlign).toBeUndefined();
		expect(restored.content[1]?.attrs?.textAlign).toBe("center");
		expect(restored.content[2]?.attrs?.textAlign).toBe("right");
	});
});
