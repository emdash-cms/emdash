import { describe, expect, it } from "vitest";

import { extractMediaUsageOccurrences } from "../../../src/media/usage/extractor.js";
import type { MediaUsageExtractionField } from "../../../src/media/usage/types.js";

function field(
	slug: string,
	type: MediaUsageExtractionField["type"],
	validation?: MediaUsageExtractionField["validation"],
): MediaUsageExtractionField {
	return { slug, type, validation };
}

describe("extractMediaUsageOccurrences", () => {
	it("extracts top-level image and file field references", () => {
		const occurrences = extractMediaUsageOccurrences({
			fields: [field("hero", "image"), field("attachment", "file"), field("title", "string")],
			data: {
				hero: {
					id: "media-hero",
					provider: "local",
					mimeType: "Image/JPEG; charset=utf-8",
				},
				attachment: {
					id: "media-file",
					provider: "local",
					mimeType: "application/pdf",
				},
				title: "media-title",
			},
		});

		expect(occurrences).toEqual([
			{
				fieldSlug: "hero",
				fieldPath: "hero",
				occurrenceIndex: 0,
				referenceType: "image_field",
				mediaId: "media-hero",
				provider: "local",
				providerAssetId: "media-hero",
				mediaKind: "image",
				mimeType: "image/jpeg",
			},
			{
				fieldSlug: "attachment",
				fieldPath: "attachment",
				occurrenceIndex: 0,
				referenceType: "file_field",
				mediaId: "media-file",
				provider: "local",
				providerAssetId: "media-file",
				mediaKind: "document",
				mimeType: "application/pdf",
			},
		]);
	});

	it("extracts legacy bare local IDs and skips URLs or internal file routes", () => {
		const occurrences = extractMediaUsageOccurrences({
			fields: [
				field("hero", "image"),
				field("attachment", "file"),
				field("external", "image"),
				field("internal", "image"),
				field("blank", "image"),
			],
			data: {
				hero: "media-hero",
				attachment: "media-file",
				external: "https://example.com/photo.jpg",
				internal: "/_emdash/api/media/file/uploads/photo.jpg",
				blank: "   ",
			},
		});

		expect(occurrences).toEqual([
			{
				fieldSlug: "hero",
				fieldPath: "hero",
				occurrenceIndex: 0,
				referenceType: "image_field",
				mediaId: "media-hero",
				provider: "local",
				providerAssetId: "media-hero",
				mediaKind: "image",
				mimeType: null,
			},
			{
				fieldSlug: "attachment",
				fieldPath: "attachment",
				occurrenceIndex: 0,
				referenceType: "file_field",
				mediaId: "media-file",
				provider: "local",
				providerAssetId: "media-file",
				mediaKind: null,
				mimeType: null,
			},
		]);
	});

	it("extracts structured external provider references without local media IDs", () => {
		const occurrences = extractMediaUsageOccurrences({
			fields: [field("hero", "image"), field("video", "file")],
			data: {
				hero: {
					id: "cf-image-1",
					provider: "cloudflare-images",
					mimeType: "image/png",
				},
				video: {
					id: "mux-video-1",
					provider: "mux",
					mimeType: "video/mp4",
				},
			},
		});

		expect(occurrences).toEqual([
			{
				fieldSlug: "hero",
				fieldPath: "hero",
				occurrenceIndex: 0,
				referenceType: "image_field",
				mediaId: null,
				provider: "cloudflare-images",
				providerAssetId: "cf-image-1",
				mediaKind: "image",
				mimeType: "image/png",
			},
			{
				fieldSlug: "video",
				fieldPath: "video",
				occurrenceIndex: 0,
				referenceType: "file_field",
				mediaId: null,
				provider: "mux",
				providerAssetId: "mux-video-1",
				mediaKind: "video",
				mimeType: "video/mp4",
			},
		]);
	});

	it("extracts repeater image and defensive file subfields with stable paths", () => {
		const occurrences = extractMediaUsageOccurrences({
			fields: [
				field("sections", "repeater", {
					subFields: [
						{ slug: "image", type: "image", label: "Image" },
						{ slug: "download", type: "file", label: "Download" },
					],
				}),
			],
			data: {
				sections: [
					{
						image: { id: "image-1", mimeType: "image/webp" },
						download: { id: "file-1", mimeType: "application/zip" },
					},
					{
						image: "image-2",
						download: {
							id: "video-1",
							provider: "mux",
							mimeType: "video/mp4",
						},
					},
				],
			},
		});

		expect(occurrences).toEqual([
			{
				fieldSlug: "sections",
				fieldPath: "sections[0].image",
				occurrenceIndex: 0,
				referenceType: "image_field",
				mediaId: "image-1",
				provider: "local",
				providerAssetId: "image-1",
				mediaKind: "image",
				mimeType: "image/webp",
			},
			{
				fieldSlug: "sections",
				fieldPath: "sections[0].download",
				occurrenceIndex: 0,
				referenceType: "file_field",
				mediaId: "file-1",
				provider: "local",
				providerAssetId: "file-1",
				mediaKind: "archive",
				mimeType: "application/zip",
			},
			{
				fieldSlug: "sections",
				fieldPath: "sections[1].image",
				occurrenceIndex: 0,
				referenceType: "image_field",
				mediaId: "image-2",
				provider: "local",
				providerAssetId: "image-2",
				mediaKind: "image",
				mimeType: null,
			},
			{
				fieldSlug: "sections",
				fieldPath: "sections[1].download",
				occurrenceIndex: 0,
				referenceType: "file_field",
				mediaId: null,
				provider: "mux",
				providerAssetId: "video-1",
				mediaKind: "video",
				mimeType: "video/mp4",
			},
		]);
	});

	it("extracts Portable Text image block asset refs", () => {
		const occurrences = extractMediaUsageOccurrences({
			fields: [field("body", "portableText")],
			data: {
				body: [
					{ _type: "block", _key: "p1", children: [] },
					{
						_type: "image",
						_key: "img1",
						asset: {
							_ref: "local-image",
							url: "/_emdash/api/media/file/local-image.jpg",
						},
					},
					{
						_type: "image",
						_key: "img2",
						asset: {
							id: "cf-image",
							provider: "cloudflare-images",
							mimeType: "image/avif",
						},
					},
					{ _type: "image", _key: "img3", asset: { url: "https://example.com/cat.jpg" } },
					{ _type: "image", _key: "img4" },
				],
			},
		});

		expect(occurrences).toEqual([
			{
				fieldSlug: "body",
				fieldPath: "body[1].asset._ref",
				occurrenceIndex: 0,
				referenceType: "portable_text_image",
				mediaId: "local-image",
				provider: "local",
				providerAssetId: "local-image",
				mediaKind: "image",
				mimeType: null,
			},
			{
				fieldSlug: "body",
				fieldPath: "body[2].asset.id",
				occurrenceIndex: 0,
				referenceType: "portable_text_image",
				mediaId: null,
				provider: "cloudflare-images",
				providerAssetId: "cf-image",
				mediaKind: "image",
				mimeType: "image/avif",
			},
		]);
	});

	it("skips URL-only and malformed media values", () => {
		const occurrences = extractMediaUsageOccurrences({
			fields: [
				field("hero", "image"),
				field("srcOnly", "image"),
				field("externalProvider", "image"),
				field("badId", "file"),
				field("pt", "portableText"),
			],
			data: {
				hero: { id: "https://example.com/photo.jpg", provider: "local" },
				srcOnly: { src: "https://example.com/photo.jpg" },
				externalProvider: {
					provider: "external",
					id: "",
					src: "https://example.com/photo.jpg",
				},
				badId: { id: 123, provider: "local" },
				pt: [
					{
						_type: "image",
						asset: { _ref: "/_emdash/api/media/file/uploads/photo.jpg" },
					},
				],
			},
		});

		expect(occurrences).toEqual([]);
	});

	it("dedupes exact duplicate occurrence identities without collapsing repeated media uses", () => {
		const occurrences = extractMediaUsageOccurrences({
			fields: [
				field("hero", "image"),
				field("hero", "image"),
				field("sections", "repeater", {
					subFields: [{ slug: "image", type: "image", label: "Image" }],
				}),
				field("body", "portableText"),
			],
			data: {
				hero: { id: "shared-media" },
				sections: [{ image: { id: "shared-media" } }],
				body: [{ _type: "image", asset: { _ref: "shared-media" } }],
			},
		});

		expect(occurrences).toEqual([
			{
				fieldSlug: "hero",
				fieldPath: "hero",
				occurrenceIndex: 0,
				referenceType: "image_field",
				mediaId: "shared-media",
				provider: "local",
				providerAssetId: "shared-media",
				mediaKind: "image",
				mimeType: null,
			},
			{
				fieldSlug: "sections",
				fieldPath: "sections[0].image",
				occurrenceIndex: 0,
				referenceType: "image_field",
				mediaId: "shared-media",
				provider: "local",
				providerAssetId: "shared-media",
				mediaKind: "image",
				mimeType: null,
			},
			{
				fieldSlug: "body",
				fieldPath: "body[0].asset._ref",
				occurrenceIndex: 0,
				referenceType: "portable_text_image",
				mediaId: "shared-media",
				provider: "local",
				providerAssetId: "shared-media",
				mediaKind: "image",
				mimeType: null,
			},
		]);
	});
});
