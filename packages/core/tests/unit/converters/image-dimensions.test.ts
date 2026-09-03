import { describe, it, expect } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type { PortableTextImageBlock } from "../../../src/content/converters/types.js";

describe("Image dimension round-trip", () => {
	const imageBlock: PortableTextImageBlock = {
		_type: "image",
		_key: "abc123",
		asset: { _ref: "media-123", url: "https://example.com/photo.jpg" },
		alt: "A photo",
		caption: "My caption",
		title: "Photo details",
		width: 1920,
		height: 1080,
		displayWidth: 400,
		displayHeight: 225,
	};

	it("preserves displayWidth and displayHeight through PT → PM → PT", () => {
		// PT → PM
		const pm = portableTextToProsemirror([imageBlock]);
		const imageNode = pm.content[0];

		expect(imageNode.type).toBe("image");
		expect(imageNode.attrs?.displayWidth).toBe(400);
		expect(imageNode.attrs?.displayHeight).toBe(225);
		expect(imageNode.attrs?.width).toBe(1920);
		expect(imageNode.attrs?.height).toBe(1080);

		// PM → PT
		const pt = prosemirrorToPortableText(pm);
		const restored = pt[0] as PortableTextImageBlock;

		expect(restored._type).toBe("image");
		expect(restored.displayWidth).toBe(400);
		expect(restored.displayHeight).toBe(225);
		expect(restored.width).toBe(1920);
		expect(restored.height).toBe(1080);
		expect(restored.caption).toBe("My caption");
		expect(restored.title).toBe("Photo details");
	});

	it("handles images without display dimensions", () => {
		const noDisplayDims: PortableTextImageBlock = {
			_type: "image",
			_key: "def456",
			asset: { _ref: "media-456", url: "https://example.com/other.jpg" },
			width: 800,
			height: 600,
		};

		const pm = portableTextToProsemirror([noDisplayDims]);
		const pt = prosemirrorToPortableText(pm);
		const restored = pt[0] as PortableTextImageBlock;

		expect(restored.displayWidth).toBeUndefined();
		expect(restored.displayHeight).toBeUndefined();
		expect(restored.width).toBe(800);
		expect(restored.height).toBe(600);
	});

	it("reads captions from title-only legacy image nodes", () => {
		const [restored] = prosemirrorToPortableText({
			type: "doc",
			content: [
				{
					type: "image",
					attrs: { src: "https://example.com/legacy.jpg", title: "Legacy caption" },
				},
			],
		});

		expect((restored as PortableTextImageBlock).caption).toBe("Legacy caption");
	});

	it("does not restore an explicitly cleared caption from the title", () => {
		const [restored] = prosemirrorToPortableText({
			type: "doc",
			content: [
				{
					type: "image",
					attrs: {
						src: "https://example.com/current.jpg",
						caption: "",
						title: "Tooltip",
					},
				},
			],
		});

		expect((restored as PortableTextImageBlock).caption).toBeUndefined();
		expect((restored as PortableTextImageBlock).title).toBe("Tooltip");
	});
});
