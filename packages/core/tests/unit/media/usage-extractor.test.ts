import { describe, expect, it } from "vitest";

import {
	extractContentMediaUsage,
	type MediaUsageIndexedField,
} from "../../../src/media/usage-extractor.js";

const fields: MediaUsageIndexedField[] = [
	{ slug: "hero", type: "image" },
	{ slug: "attachment", type: "file" },
	{
		slug: "gallery",
		type: "repeater",
		validation: { subFields: [{ slug: "image", label: "Image", type: "image" }] },
	},
	{ slug: "body", type: "portableText" },
];

describe("extractContentMediaUsage", () => {
	it("extracts local media references from supported field shapes", () => {
		const refs = extractContentMediaUsage(fields, {
			hero: { id: "media_hero", provider: "local" },
			attachment: { id: "media_file", mimeType: "application/pdf" },
			gallery: [{ image: { id: "media_gallery", provider: "local" } }],
			body: [
				{
					_type: "image",
					_key: "image1",
					asset: { _ref: "media_body", url: "/_emdash/api/media/file/key.jpg" },
				},
			],
		});

		expect(refs).toEqual([
			{
				mediaId: "media_hero",
				provider: "local",
				providerAssetId: "media_hero",
				mediaKind: "image",
				mimeType: null,
				referenceType: "image_field",
				fieldPath: "hero",
			},
			{
				mediaId: "media_file",
				provider: "local",
				providerAssetId: "media_file",
				mediaKind: "document",
				mimeType: "application/pdf",
				referenceType: "file_field",
				fieldPath: "attachment",
			},
			{
				mediaId: "media_gallery",
				provider: "local",
				providerAssetId: "media_gallery",
				mediaKind: "image",
				mimeType: null,
				referenceType: "repeater_image_subfield",
				fieldPath: "gallery[0].image",
			},
			{
				mediaId: "media_body",
				provider: "local",
				providerAssetId: "media_body",
				mediaKind: "image",
				mimeType: null,
				referenceType: "portable_text_image",
				fieldPath: "body[0].asset._ref",
			},
		]);
	});

	it("extracts structured non-local provider references", () => {
		const refs = extractContentMediaUsage(fields, {
			hero: { id: "cf_image_1", provider: "cloudflare-images", mimeType: "image/webp" },
			attachment: { id: "mux_asset_1", provider: "mux", mimeType: "video/mp4" },
			body: [
				{
					_type: "image",
					_key: "provider-image",
					asset: { _ref: "remote_img_1", provider: "cloudinary", mimeType: "image/jpeg" },
				},
			],
		});

		expect(refs).toMatchObject([
			{
				mediaId: null,
				provider: "cloudflare-images",
				providerAssetId: "cf_image_1",
				mediaKind: "image",
				mimeType: "image/webp",
			},
			{
				mediaId: null,
				provider: "mux",
				providerAssetId: "mux_asset_1",
				mediaKind: "video",
				mimeType: "video/mp4",
			},
			{
				mediaId: null,
				provider: "cloudinary",
				providerAssetId: "remote_img_1",
				mediaKind: "image",
				mimeType: "image/jpeg",
			},
		]);
	});

	it("ignores external URLs and malformed media values", () => {
		const refs = extractContentMediaUsage(fields, {
			hero: { id: "", provider: "cloudflare-images" },
			attachment: "https://example.com/file.pdf",
			gallery: [{ image: { id: 123, provider: "local" } }],
			body: [
				{ _type: "image", _key: "external", asset: { _ref: "https://example.com/a.jpg" } },
				{ _type: "image", _key: "url", asset: { url: "https://example.com/image.jpg" } },
			],
		});

		expect(refs).toEqual([]);
	});

	it("dedupes repeated references at the same field path", () => {
		const refs = extractContentMediaUsage(fields, {
			hero: { id: "media_hero", provider: "local" },
			body: [],
		});

		expect(refs).toHaveLength(1);
	});
});
