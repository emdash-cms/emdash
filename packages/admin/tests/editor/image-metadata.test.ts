import { describe, expect, it } from "vitest";

import {
	_portableTextToProsemirror as portableTextToProsemirror,
	_prosemirrorToPortableText as prosemirrorToPortableText,
} from "../../src/components/PortableTextEditor.js";

describe("admin editor image metadata", () => {
	it("keeps captions and tooltip titles independent through a round trip", () => {
		const pm = portableTextToProsemirror([
			{
				_type: "image",
				_key: "image-1",
				asset: { _ref: "media-1", url: "/photo.jpg" },
				alt: "A photo",
				caption: "Visible caption",
				title: "Hover title",
			} as never,
		]);

		const restored = prosemirrorToPortableText(pm)[0] as Record<string, unknown>;

		expect(restored.caption).toBe("Visible caption");
		expect(restored.title).toBe("Hover title");
	});

	it("keeps a cleared caption separate from the tooltip title across reloads", () => {
		const portableText = prosemirrorToPortableText({
			type: "doc",
			content: [
				{
					type: "image",
					attrs: {
						src: "/photo.jpg",
						mediaId: "media-1",
						caption: "",
						title: "Hover title",
					},
				},
			],
		});
		const restored = prosemirrorToPortableText(
			portableTextToProsemirror(portableText),
		)[0] as Record<string, unknown>;

		expect(restored.caption).toBe("");
		expect(restored.title).toBe("Hover title");
	});

	it("reads captions from title-only legacy Portable Text blocks", () => {
		const restored = prosemirrorToPortableText(
			portableTextToProsemirror([
				{
					_type: "image",
					_key: "image-legacy",
					asset: { _ref: "media-1", url: "/photo.jpg" },
					title: "Legacy caption",
				} as never,
			]),
		)[0] as Record<string, unknown>;

		expect(restored.caption).toBe("Legacy caption");
		expect(restored.title).toBe("Legacy caption");
	});

	it("reads captions from title-only image blocks without an asset wrapper", () => {
		const pm = portableTextToProsemirror([
			{
				_type: "image",
				_key: "image-malformed",
				url: "/photo.jpg",
				title: "Legacy caption",
			} as never,
		]);
		const image = pm.content?.[0] as { attrs?: Record<string, unknown> };

		expect(image.attrs?.src).toBe("/photo.jpg");
		expect(image.attrs?.caption).toBe("Legacy caption");
	});
});
