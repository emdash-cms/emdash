import { describe, expect, it } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";

const image = {
	_type: "image",
	_key: "image-1",
	asset: {
		_ref: "provider-image",
		url: "https://example.com/photo.jpg",
		provider: "cloudflare-images",
	},
	alt: "A photo",
	caption: "A caption",
	width: 1200,
	height: 800,
	displayWidth: 600,
	displayHeight: 400,
};
const attrs = {
	src: image.asset.url,
	mediaId: image.asset._ref,
	provider: image.asset.provider,
	alt: image.alt,
	title: image.caption,
	width: image.width,
	height: image.height,
	displayWidth: image.displayWidth,
	displayHeight: image.displayHeight,
};

describe("Exported image alignment converters", () => {
	it.each(["left", "center", "right", "wide", "full"])(
		"preserves %s alignment in both directions",
		(alignment) => {
			const document = portableTextToProsemirror([{ ...image, alignment }]);
			expect(document.content[0]?.attrs).toMatchObject({ ...attrs, alignment });
			const restored = prosemirrorToPortableText({
				type: "doc",
				content: [{ type: "image", attrs: { ...attrs, alignment } }],
			});
			expect(restored[0]).toMatchObject({ ...image, _key: expect.any(String), alignment });
			expect(portableTextToProsemirror(restored).content[0]?.attrs).toMatchObject({
				...attrs,
				alignment,
			});
			expect(prosemirrorToPortableText(document)[0]).toMatchObject({
				...image,
				_key: expect.any(String),
				alignment,
			});
		},
	);

	it.each(["left", "center", "right", "wide", "full"])(
		"retains %s alignment when recovering a missing asset wrapper",
		(alignment) => {
			const document = portableTextToProsemirror([
				{ _type: "image", _key: "legacy", url: image.asset.url, alignment },
			]);
			expect(document.content[0]?.attrs).toMatchObject({ src: image.asset.url, alignment });
			expect(prosemirrorToPortableText(document)[0]).toMatchObject({ alignment });
		},
	);

	it.each([undefined, null, "none", "unknown", "LEFT", 123, ["left"]])(
		"omits invalid runtime alignment %j",
		(alignment) => {
			for (const block of [
				{ ...image, alignment },
				{ _type: "image", _key: "legacy", url: image.asset.url, alignment },
			]) {
				expect(portableTextToProsemirror([block]).content[0]?.attrs?.alignment).toBeUndefined();
			}
			const restored = prosemirrorToPortableText({
				type: "doc",
				content: [{ type: "image", attrs: { ...attrs, alignment } }],
			});
			expect(restored[0]?.alignment).toBeUndefined();
		},
	);
});
