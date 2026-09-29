import { describe, it, expect } from "vitest";

import {
	_portableTextToProsemirror,
	_prosemirrorToPortableText,
} from "../src/components/PortableTextEditor";

describe("Image conversion (admin converters): PortableText ↔ ProseMirror", () => {
	it("keeps the media reference of a seeded $media asset", () => {
		const seeded = [
			{
				_type: "image",
				_key: "img1",
				asset: {
					provider: "local",
					id: "01M2QZRZTZPBJ2WV8A3B61ZZX7",
					alt: "A photo",
					width: 1400,
					height: 963,
					mimeType: "image/jpeg",
					meta: { storageKey: "01M2QZRZR8HDNT3039QNQ95B9D.jpg" },
				},
				caption: "A caption",
			},
			{
				_type: "image",
				_key: "img2",
				asset: { provider: "external", id: "01EXT", src: "https://example.com/photo.jpg" },
			},
		];

		const pt = _prosemirrorToPortableText(_portableTextToProsemirror(seeded));
		expect(pt).toEqual([
			{
				_type: "image",
				_key: "img1",
				asset: {
					_ref: "01M2QZRZTZPBJ2WV8A3B61ZZX7",
					url: "/_emdash/api/media/file/01M2QZRZR8HDNT3039QNQ95B9D.jpg",
				},
				alt: "A photo",
				caption: "A caption",
				width: 1400,
				height: 963,
			},
			{
				_type: "image",
				_key: "img2",
				asset: {
					_ref: "01EXT",
					url: "https://example.com/photo.jpg",
					provider: "external",
				},
			},
		]);
	});
});
