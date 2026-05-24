import { describe, it, expect } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import type { PortableTextBlock } from "../../../src/content/converters/types.js";

describe("Image blocks without asset wrapper", () => {
	it("does not crash when an image block has url at the top level instead of inside asset", () => {
		// This is the format that can originate from migrations or third-party imports
		// (e.g. Ghost → Portable Text). Without the fix, accessing block.asset.url
		// throws TypeError: Cannot read properties of undefined (reading 'url').
		const blocks: PortableTextBlock[] = [
			{
				_type: "block",
				_key: "b1",
				style: "normal",
				children: [{ _type: "span", _key: "s1", text: "Before image", marks: [] }],
				markDefs: [],
			},
			{
				_type: "image",
				_key: "img1",
				url: "https://example.com/photo.jpg",
				alt: "A photo without asset wrapper",
			} as unknown as PortableTextBlock,
			{
				_type: "block",
				_key: "b2",
				style: "normal",
				children: [{ _type: "span", _key: "s2", text: "After image", marks: [] }],
				markDefs: [],
			},
		];

		const result = portableTextToProsemirror(blocks);

		expect(result.type).toBe("doc");
		expect(result.content).toHaveLength(3);
	});

	it("extracts src and alt from top-level url when asset is missing", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "image",
				_key: "img1",
				url: "https://example.com/photo.jpg",
				alt: "A test image",
			} as unknown as PortableTextBlock,
		];

		const result = portableTextToProsemirror(blocks);
		const imageNode = result.content[0];

		expect(imageNode.type).toBe("image");
		expect(imageNode.attrs?.src).toBe("https://example.com/photo.jpg");
		expect(imageNode.attrs?.alt).toBe("A test image");
	});

	it("handles image block with neither asset nor url gracefully", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "image",
				_key: "img1",
			} as unknown as PortableTextBlock,
		];

		const result = portableTextToProsemirror(blocks);
		const imageNode = result.content[0];

		expect(imageNode.type).toBe("image");
		expect(imageNode.attrs?.src).toBe("");
		expect(imageNode.attrs?.alt).toBe("");
	});

	it("still converts well-formed image blocks with asset wrapper correctly", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "image",
				_key: "img1",
				asset: { _ref: "media-123", url: "https://example.com/photo.jpg" },
				alt: "A proper image",
			},
		];

		const result = portableTextToProsemirror(blocks);
		const imageNode = result.content[0];

		expect(imageNode.type).toBe("image");
		expect(imageNode.attrs?.src).toBe("https://example.com/photo.jpg");
		expect(imageNode.attrs?.alt).toBe("A proper image");
		expect(imageNode.attrs?.mediaId).toBe("media-123");
	});
});
