import { describe, expect, it } from "vitest";

import {
	_portableTextToProsemirror as portableTextToProsemirror,
	_prosemirrorToPortableText as prosemirrorToPortableText,
} from "../../src/components/PortableTextEditor";

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

	it("does not restore a cleared caption from the tooltip title", () => {
		const restored = prosemirrorToPortableText({
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
		})[0] as Record<string, unknown>;

		expect(restored.caption).toBeUndefined();
		expect(restored.title).toBe("Hover title");
	});

	it("reads captions from title-only legacy image nodes", () => {
		const restored = prosemirrorToPortableText({
			type: "doc",
			content: [
				{
					type: "image",
					attrs: {
						src: "/photo.jpg",
						mediaId: "media-1",
						title: "Legacy caption",
					},
				},
			],
		})[0] as Record<string, unknown>;

		expect(restored.caption).toBe("Legacy caption");
		expect(restored.title).toBe("Legacy caption");
	});
});
