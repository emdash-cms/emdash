/**
 * Guards against the core (`packages/core/src/content/converters`) and admin
 * (`PortableTextEditor.tsx`, duplicated for editor-only reasons) gallery
 * converter pair drifting apart. Round-trips a WordPress-shaped gallery
 * block — the exact shape emitted by `@emdash-cms/gutenberg-to-portable-text`
 * after the import media pass — through the admin's PT → PM → PT converters.
 */
import { describe, it, expect } from "vitest";

import {
	_portableTextToProsemirror,
	_prosemirrorToPortableText,
} from "../src/components/PortableTextEditor";

describe("Gallery conversion (admin converters): PortableText ↔ ProseMirror", () => {
	it("round-trips a WordPress-shaped gallery block without loss", () => {
		const imported = [
			{
				_type: "gallery",
				_key: "wpgal1",
				images: [
					{
						_type: "image",
						_key: "wpimg1",
						asset: {
							_type: "reference",
							_ref: "01ABC",
							url: "/_emdash/api/media/file/01ABC.jpg",
							provider: "cloudflare-images",
						},
						alt: "Beach",
						caption: "Summer 2019",
						blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
						dominantColor: "#336699",
					},
					{
						_type: "image",
						_key: "wpimg2",
						asset: { _type: "reference", _ref: "42", url: "https://old-site.com/photo.jpg" },
					},
				],
				columns: 3,
			},
		];

		const pm = _portableTextToProsemirror(imported);
		const galleryNode = pm.content[0] as { type: string; attrs?: Record<string, unknown> };
		expect(galleryNode.type).toBe("gallery");
		expect(galleryNode.attrs?.images).toHaveLength(2);

		const pt = _prosemirrorToPortableText(pm);
		const restored = pt[0] as {
			_type: string;
			images: Array<Record<string, unknown>>;
			columns?: number;
		};

		expect(restored._type).toBe("gallery");
		expect(restored.columns).toBe(3);
		expect(restored.images).toHaveLength(2);

		const [first, second] = restored.images;
		expect(first).toMatchObject({
			_type: "image",
			asset: {
				_type: "reference",
				_ref: "01ABC",
				url: "/_emdash/api/media/file/01ABC.jpg",
				provider: "cloudflare-images",
			},
			alt: "Beach",
			caption: "Summer 2019",
			blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
			dominantColor: "#336699",
		});
		expect(second).toMatchObject({
			_type: "image",
			asset: { _type: "reference", _ref: "42", url: "https://old-site.com/photo.jpg" },
		});
		// Local (non-external) provider must never round-trip as a literal
		// "local" string on asset.provider — it's omitted, matching the image
		// block and image-field paths.
		expect(second?.asset).not.toHaveProperty("provider");
	});

	it("encodes a seeded storage key into the file route like core does", () => {
		const seeded = [
			{
				_type: "gallery",
				_key: "seedgal",
				images: [
					{
						_type: "image",
						_key: "img1",
						asset: { provider: "local", id: "01M", meta: { storageKey: "uploads/a b#1.jpg" } },
					},
				],
			},
		];

		const pt = _prosemirrorToPortableText(_portableTextToProsemirror(seeded));
		const restored = pt[0] as { images: Array<{ asset: { url?: string } }> };
		expect(restored.images[0]?.asset.url).toBe("/_emdash/api/media/file/uploads/a%20b%231.jpg");
	});

	it("keeps the media reference of a seeded $media asset", () => {
		const seeded = [
			{
				_type: "gallery",
				_key: "seedgal",
				images: [
					{
						_type: "image",
						_key: "img1",
						asset: {
							provider: "local",
							id: "01M2QZRZTZPBJ2WV8A3B61ZZX7",
							meta: { storageKey: "01M2QZRZR8HDNT3039QNQ95B9D.jpg" },
						},
					},
					{
						_type: "image",
						_key: "img2",
						asset: { provider: "external", id: "01EXT", src: "https://example.com/photo.jpg" },
					},
				],
			},
		];

		const pt = _prosemirrorToPortableText(_portableTextToProsemirror(seeded));
		const restored = pt[0] as { images: Array<{ asset: Record<string, unknown> }> };
		expect(restored.images.map((image) => image.asset)).toEqual([
			{
				_type: "reference",
				_ref: "01M2QZRZTZPBJ2WV8A3B61ZZX7",
				url: "/_emdash/api/media/file/01M2QZRZR8HDNT3039QNQ95B9D.jpg",
				provider: "local",
			},
			{
				_type: "reference",
				_ref: "01EXT",
				url: "https://example.com/photo.jpg",
				provider: "external",
			},
		]);
	});
});
