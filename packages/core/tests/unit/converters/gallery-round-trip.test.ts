import { describe, it, expect } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type { PortableTextGalleryBlock } from "../../../src/content/converters/types.js";

const gallery: PortableTextGalleryBlock = {
	_type: "gallery",
	_key: "gal001",
	images: [
		{
			_type: "image",
			_key: "img001",
			asset: { _ref: "media-a" },
			alt: "First",
			caption: "A local image",
			width: 800,
			height: 600,
		},
		{
			_type: "image",
			_key: "img002",
			asset: { _ref: "", url: "https://example.com/photo.jpg" },
			alt: "External",
		},
	],
	columns: 4,
};

describe("gallery block round-trip (core converters)", () => {
	it("converts a gallery block to a gallery ProseMirror node", () => {
		const pm = portableTextToProsemirror([gallery]);
		const node = pm.content[0];

		expect(node.type).toBe("gallery");
		expect(node.attrs?.columns).toBe(4);
		expect(node.attrs?.images).toHaveLength(2);
	});

	it("preserves images, captions, dimensions, and columns through PT → PM → PT", () => {
		const pm = portableTextToProsemirror([gallery]);
		const pt = prosemirrorToPortableText(pm);
		const restored = pt[0] as PortableTextGalleryBlock;

		expect(restored._type).toBe("gallery");
		expect(restored._key).toBeDefined();
		expect(restored.columns).toBe(4);
		expect(restored.images).toHaveLength(2);

		const [first, second] = restored.images;
		expect(first).toMatchObject({
			_type: "image",
			asset: { _ref: "media-a" },
			alt: "First",
			caption: "A local image",
			width: 800,
			height: 600,
		});
		expect(first._key).toBeDefined();
		expect(second).toMatchObject({
			_type: "image",
			asset: { _ref: "", url: "https://example.com/photo.jpg" },
			alt: "External",
		});
	});

	it("omits columns when not set and survives an empty images list", () => {
		const minimal: PortableTextGalleryBlock = {
			_type: "gallery",
			_key: "gal002",
			images: [],
		};

		const pm = portableTextToProsemirror([minimal]);
		expect(pm.content[0].type).toBe("gallery");

		const pt = prosemirrorToPortableText(pm);
		const restored = pt[0] as PortableTextGalleryBlock;
		expect(restored._type).toBe("gallery");
		expect(restored.images).toEqual([]);
		expect(restored.columns).toBeUndefined();
	});

	it("drops non-object entries in images instead of crashing", () => {
		const dirty = {
			_type: "gallery",
			_key: "gal003",
			images: [null, "junk", { _type: "image", _key: "ok1", asset: { _ref: "media-b" } }],
		};

		const pm = portableTextToProsemirror([dirty as never]);
		expect(pm.content[0].type).toBe("gallery");
		expect(pm.content[0].attrs?.images).toHaveLength(1);

		const pt = prosemirrorToPortableText(pm);
		const restored = pt[0] as PortableTextGalleryBlock;
		expect(restored.images).toHaveLength(1);
		expect(restored.images[0].asset._ref).toBe("media-b");
	});

	it("still falls back to the unknown-block placeholder for a gallery without an images array", () => {
		const malformed = { _type: "gallery", _key: "gal004" };
		const pm = portableTextToProsemirror([malformed as never]);
		expect(pm.content[0].type).toBe("paragraph");
	});

	it("round-trips a WordPress-imported gallery without loss", () => {
		// Exact shape emitted by @emdash-cms/gutenberg-to-portable-text `gallery`
		// transformer after the import media pass (asset._type "reference",
		// rewritten _ref/url, per-image caption, no width/height, columns attr).
		const imported = {
			_type: "gallery",
			_key: "wpgal1",
			images: [
				{
					_type: "image",
					_key: "wpimg1",
					asset: {
						_type: "reference",
						_ref: "/_emdash/api/media/file/01ABC.jpg",
						url: "/_emdash/api/media/file/01ABC.jpg",
					},
					alt: "Beach",
					caption: "Summer 2019",
				},
				{
					_type: "image",
					_key: "wpimg2",
					asset: { _type: "reference", _ref: "42", url: "https://old-site.com/photo.jpg" },
					alt: undefined,
					caption: undefined,
				},
			],
			columns: 3,
		};

		const pm = portableTextToProsemirror([imported as never]);
		expect(pm.content[0].type).toBe("gallery");

		const pt = prosemirrorToPortableText(pm);
		const restored = pt[0] as PortableTextGalleryBlock;

		expect(restored._type).toBe("gallery");
		expect(restored.columns).toBe(3);
		expect(restored.images).toHaveLength(2);
		expect(restored.images[0]).toMatchObject({
			_type: "image",
			asset: {
				_type: "reference",
				_ref: "/_emdash/api/media/file/01ABC.jpg",
				url: "/_emdash/api/media/file/01ABC.jpg",
			},
			alt: "Beach",
			caption: "Summer 2019",
		});
		expect(restored.images[1].asset).toEqual({
			_type: "reference",
			_ref: "42",
			url: "https://old-site.com/photo.jpg",
		});
	});

	it("preserves provider, blurhash, and dominantColor through PT → PM → PT", () => {
		const withMeta: PortableTextGalleryBlock = {
			_type: "gallery",
			_key: "gal005",
			images: [
				{
					_type: "image",
					_key: "img005",
					asset: { _type: "reference", _ref: "media-c", provider: "cloudflare-images" },
					alt: "Provider image",
					blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
					dominantColor: "#a3b1c2",
				},
			],
		};

		const pm = portableTextToProsemirror([withMeta]);
		const node = pm.content[0];
		expect(node.attrs?.images).toHaveLength(1);

		const pt = prosemirrorToPortableText(pm);
		const restored = pt[0] as PortableTextGalleryBlock;
		expect(restored.images[0]).toMatchObject({
			asset: { _ref: "media-c", provider: "cloudflare-images" },
			blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
			dominantColor: "#a3b1c2",
		});
	});

	it("preserves galleries among other block types", () => {
		const blocks = [
			{
				_type: "block" as const,
				_key: "txt001",
				style: "normal" as const,
				children: [{ _type: "span" as const, _key: "s1", text: "Before" }],
			},
			gallery,
			{
				_type: "block" as const,
				_key: "txt002",
				style: "normal" as const,
				children: [{ _type: "span" as const, _key: "s2", text: "After" }],
			},
		];

		const pm = portableTextToProsemirror(blocks);
		expect(pm.content.map((n) => n.type)).toEqual(["paragraph", "gallery", "paragraph"]);

		const pt = prosemirrorToPortableText(pm);
		expect(pt.map((b) => b._type)).toEqual(["block", "gallery", "block"]);
	});
});
