import { describe, it, expect } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type { PortableTextBlock } from "../../../src/content/converters/types.js";

describe("image block round-trip (core converters)", () => {
	it("keeps the media reference of a seeded $media asset", () => {
		const seeded: PortableTextBlock[] = [
			{
				_type: "image",
				_key: "img001",
				asset: {
					provider: "local",
					id: "01M2QZRZTZPBJ2WV8A3B61ZZX7",
					alt: "Local",
					width: 1400,
					height: 963,
					mimeType: "image/jpeg",
					meta: { storageKey: "01M2QZRZR8HDNT3039QNQ95B9D.jpg" },
				},
				caption: "A caption",
			},
			{
				_type: "image",
				_key: "img002",
				asset: { provider: "external", id: "01EXT", src: "https://example.com/photo.jpg" },
			},
		];

		const pt = prosemirrorToPortableText(portableTextToProsemirror(seeded));
		expect(pt).toEqual([
			{
				_type: "image",
				_key: expect.any(String),
				asset: {
					_ref: "01M2QZRZTZPBJ2WV8A3B61ZZX7",
					url: "/_emdash/api/media/file/01M2QZRZR8HDNT3039QNQ95B9D.jpg",
				},
				alt: "Local",
				caption: "A caption",
				width: 1400,
				height: 963,
			},
			{
				_type: "image",
				_key: expect.any(String),
				asset: {
					_ref: "01EXT",
					url: "https://example.com/photo.jpg",
					provider: "external",
				},
			},
		]);
	});
});
