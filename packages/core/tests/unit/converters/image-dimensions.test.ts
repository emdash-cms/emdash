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

	it("preserves a legacy local storage key through PT → PM → PT", () => {
		const legacyImage = {
			_type: "image",
			_key: "legacy-image",
			asset: {
				_ref: "legacy-local-id",
				meta: { storageKey: "01ABC.jpg" },
			},
		} as PortableTextImageBlock;

		const pm = portableTextToProsemirror([legacyImage]);
		const restored = prosemirrorToPortableText(pm)[0] as PortableTextImageBlock;

		expect(restored.asset.meta?.storageKey).toBe("01ABC.jpg");
	});
});
