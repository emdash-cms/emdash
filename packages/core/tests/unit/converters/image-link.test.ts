import { describe, it, expect } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type {
	PortableTextBlock,
	PortableTextImageBlock,
} from "../../../src/content/converters/types.js";

function makeImageBlock(link?: PortableTextImageBlock["link"]): PortableTextImageBlock {
	return {
		_type: "image",
		_key: "img1",
		asset: { _ref: "media-1", url: "https://cdn.example.com/photo.jpg" },
		alt: "A photo",
		...(link ? { link } : {}),
	};
}

describe("Image link round-trip", () => {
	it("propagates a relative link through PT → PM → PT", () => {
		const input: PortableTextBlock[] = [makeImageBlock({ href: "/page" })];

		const pm = portableTextToProsemirror(input);
		expect(pm.content[0]!.attrs?.link).toEqual({ href: "/page", blank: undefined });

		const out = prosemirrorToPortableText(pm);
		const imageOut = out[0] as PortableTextImageBlock;
		expect(imageOut._type).toBe("image");
		expect(imageOut.link).toEqual({ href: "/page" });
	});

	it("preserves blank=true on external links", () => {
		const input: PortableTextBlock[] = [
			makeImageBlock({ href: "https://example.com", blank: true }),
		];

		const pm = portableTextToProsemirror(input);
		expect(pm.content[0]!.attrs?.link).toEqual({ href: "https://example.com", blank: true });

		const out = prosemirrorToPortableText(pm);
		const imageOut = out[0] as PortableTextImageBlock;
		expect(imageOut.link).toEqual({ href: "https://example.com", blank: true });
	});

	it("omits link when absent", () => {
		const input: PortableTextBlock[] = [makeImageBlock()];

		const pm = portableTextToProsemirror(input);
		expect(pm.content[0]!.attrs?.link).toBeNull();

		const out = prosemirrorToPortableText(pm);
		const imageOut = out[0] as PortableTextImageBlock;
		expect(imageOut.link).toBeUndefined();
	});

	it("drops half-populated links with empty href", () => {
		// Simulate a PM doc whose image attrs.link has href: "" (e.g., user cleared URL)
		const pmDoc = {
			type: "doc" as const,
			content: [
				{
					type: "image",
					attrs: {
						src: "https://cdn.example.com/photo.jpg",
						alt: "A photo",
						mediaId: "media-1",
						link: { href: "", blank: true },
					},
				},
			],
		};

		const out = prosemirrorToPortableText(pmDoc);
		const imageOut = out[0] as PortableTextImageBlock;
		expect(imageOut.link).toBeUndefined();
	});

	it("drops link when href is whitespace only", () => {
		const pmDoc = {
			type: "doc" as const,
			content: [
				{
					type: "image",
					attrs: {
						src: "https://cdn.example.com/photo.jpg",
						alt: "A photo",
						mediaId: "media-1",
						link: { href: "   " },
					},
				},
			],
		};

		const out = prosemirrorToPortableText(pmDoc);
		const imageOut = out[0] as PortableTextImageBlock;
		expect(imageOut.link).toBeUndefined();
	});
});
