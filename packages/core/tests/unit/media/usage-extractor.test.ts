import { describe, expect, it } from "vitest";

import {
	extractMediaUsageOccurrences,
	MediaUsageBlockResolutionError,
} from "../../../src/media/usage/extractor.js";
import type { MediaUsageExtractionField } from "../../../src/media/usage/types.js";

function field(
	slug: string,
	type: MediaUsageExtractionField["type"],
	validation?: MediaUsageExtractionField["validation"],
): MediaUsageExtractionField {
	return { slug, type, validation };
}

function linkOccurrence(
	fieldSlug: string,
	fieldPath: string,
	storageKey: string,
	occurrenceIndex = 0,
) {
	return {
		fieldSlug,
		fieldPath,
		occurrenceIndex,
		referenceType: "link" as const,
		mediaId: null,
		provider: "local",
		providerAssetId: storageKey,
		mediaKind: null,
		mimeType: null,
		storageKey,
	};
}

describe("extractMediaUsageOccurrences", () => {
	it("counts same-origin absolute links across fields, marks, and HTML without merging distinct uses", () => {
		const url = "https://site.example/_emdash/api/media/file/guide.pdf?download=1#page=2";
		const occurrences = extractMediaUsageOccurrences({
			siteOrigin: "https://site.example",
			fields: [field("download", "url"), field("body", "portableText")],
			data: {
				download: url,
				body: [
					{ _type: "block", markDefs: [{ _type: "link", href: url }] },
					{
						_type: "htmlBlock",
						html: `<a href="${url}">PDF</a><img src="/_emdash/api/media/file/guide.pdf"><img src="https://other.example/_emdash/api/media/file/other.png">`,
					},
				],
			},
		});
		expect(occurrences).toEqual([
			linkOccurrence("download", "download", "guide.pdf"),
			linkOccurrence("body", "body[0].markDefs[0].href", "guide.pdf"),
			linkOccurrence("body", "body[1].html", "guide.pdf"),
		]);
	});

	it("uses block keys and retained version definitions for nested media", () => {
		const now = new Date().toISOString();
		const layout: MediaUsageExtractionField = {
			slug: "layout",
			type: "blocks",
			blockTypes: [
				{
					id: "hero",
					slug: "hero",
					label: "Hero",
					currentVersion: 1,
					source: "user",
					createdAt: now,
					updatedAt: now,
					versions: [
						{
							id: "hero-v1",
							blockTypeId: "hero",
							version: 1,
							fingerprint: "v1",
							active: true,
							createdAt: now,
							updatedAt: now,
							fields: [
								{ slug: "image", label: "Image", type: "image" },
								{ slug: "file", label: "File", type: "file" },
								{ slug: "body", label: "Body", type: "portableText" },
								{
									slug: "items",
									label: "Items",
									type: "repeater",
									validation: {
										subFields: [{ slug: "photo", label: "Photo", type: "image" }],
									},
								},
							],
						},
					],
				},
			],
		};
		const first = {
			_type: "hero",
			_version: 1,
			_key: "first",
			image: { id: "image-1", darkVariant: { id: "image-dark" } },
			file: { id: "file-1", mimeType: "application/pdf" },
			body: [{ _type: "image", asset: { _ref: "body-image" } }],
			items: [{ photo: { id: "repeater-image" } }],
		};
		const second = { _type: "hero", _version: 1, _key: "second", image: { id: "image-2" } };
		const extract = (blocks: unknown[]) =>
			extractMediaUsageOccurrences({ fields: [layout], data: { layout: blocks } });

		const paths = extract([first, second])
			.map((occurrence) => occurrence.fieldPath)
			.toSorted();
		expect(paths).toEqual([
			"layout.first.body[0].asset._ref",
			"layout.first.file",
			"layout.first.image",
			"layout.first.image.darkVariant",
			"layout.first.items[0].photo",
			"layout.second.image",
		]);
		expect(
			extract([second, first])
				.map((occurrence) => occurrence.fieldPath)
				.toSorted(),
		).toEqual(paths);
		expect(() => extract([{ ...first, _version: 99 }])).toThrow(MediaUsageBlockResolutionError);
	});

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
				field("protocolRelative", "image"),
				field("rootRelative", "image"),
				field("relativePath", "image"),
				field("internal", "image"),
				field("blank", "image"),
			],
			data: {
				hero: "media-hero",
				attachment: "media-file",
				external: "https://example.com/photo.jpg",
				protocolRelative: "//cdn.example.com/photo.jpg",
				rootRelative: "/images/photo.jpg",
				relativePath: "images/photo.jpg",
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
					id: "folder/cf-image-1",
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
				providerAssetId: "folder/cf-image-1",
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

	it("extracts repeater image subfields with stable paths", () => {
		const occurrences = extractMediaUsageOccurrences({
			fields: [
				field("sections", "repeater", {
					subFields: [{ slug: "image", type: "image", label: "Image" }],
				}),
			],
			data: {
				sections: [
					{ image: { id: "image-1", mimeType: "image/webp" } },
					{
						image: "image-2",
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
				fieldPath: "sections[1].image",
				occurrenceIndex: 0,
				referenceType: "image_field",
				mediaId: "image-2",
				provider: "local",
				providerAssetId: "image-2",
				mediaKind: "image",
				mimeType: null,
			},
		]);
	});

	it("extracts the dark variant of an image field and of a repeater image subfield", () => {
		const occurrences = extractMediaUsageOccurrences({
			fields: [
				field("hero", "image"),
				field("sections", "repeater", {
					subFields: [{ slug: "image", type: "image", label: "Image" }],
				}),
			],
			data: {
				hero: {
					id: "hero-light",
					provider: "local",
					mimeType: "image/png",
					darkVariant: { id: "hero-dark", provider: "local", mimeType: "image/png" },
				},
				sections: [{ image: { id: "section-light", darkVariant: "section-dark" } }],
			},
		});

		expect(occurrences.map((o) => [o.fieldPath, o.mediaId])).toEqual([
			["hero", "hero-light"],
			["hero.darkVariant", "hero-dark"],
			["sections[0].image", "section-light"],
			["sections[0].image.darkVariant", "section-dark"],
		]);
		expect(occurrences.every((o) => o.referenceType === "image_field")).toBe(true);
	});

	it("ignores unsupported repeater file subfields", () => {
		const occurrences = extractMediaUsageOccurrences({
			fields: [
				field("sections", "repeater", {
					subFields: [{ slug: "download", type: "file", label: "Download" }],
				}),
			],
			data: {
				sections: [
					{ download: { id: "file-1", mimeType: "application/zip" } },
					{
						download: {
							id: "video-1",
							provider: "mux",
							mimeType: "video/mp4",
						},
					},
				],
			},
		});

		expect(occurrences).toEqual([]);
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

	it("extracts Portable Text video block asset refs", () => {
		const occurrences = extractMediaUsageOccurrences({
			fields: [field("body", "portableText")],
			data: {
				body: [
					{
						_type: "video",
						_key: "vid1",
						asset: { _ref: "local-video", url: "/_emdash/api/media/file/local-video.mp4" },
					},
					{ _type: "video", _key: "vid2", asset: { _ref: "uid42", provider: "cloudflare-stream" } },
					{ _type: "video", _key: "vid3", asset: { _ref: "dQw4w9WgXcQ" }, source: "youtube" },
				],
			},
		});

		expect(occurrences).toEqual([
			{
				fieldSlug: "body",
				fieldPath: "body[0].asset._ref",
				occurrenceIndex: 0,
				referenceType: "portable_text_video",
				mediaId: "local-video",
				provider: "local",
				providerAssetId: "local-video",
				mediaKind: "video",
				mimeType: null,
			},
			{
				fieldSlug: "body",
				fieldPath: "body[1].asset._ref",
				occurrenceIndex: 0,
				referenceType: "portable_text_video",
				mediaId: null,
				provider: "cloudflare-stream",
				providerAssetId: "uid42",
				mediaKind: "video",
				mimeType: null,
			},
		]);
	});

	it("extracts the images inside a Portable Text gallery block (#2872)", () => {
		const occurrences = extractMediaUsageOccurrences({
			fields: [field("body", "portableText")],
			data: {
				body: [
					{ _type: "block", _key: "p1", children: [] },
					{
						_type: "gallery",
						_key: "g1",
						columns: 3,
						images: [
							{ _key: "a", asset: { _ref: "gallery-one", url: "/_emdash/api/media/file/one.jpg" } },
							{
								_key: "b",
								asset: { id: "cf-two", provider: "cloudflare-images", mimeType: "image/webp" },
							},
							{ _key: "c", asset: { url: "https://example.com/external.jpg" } },
							{ _key: "d" },
							"not-an-image",
						],
					},
					{ _type: "gallery", _key: "g2", images: "malformed" },
				],
			},
		});

		expect(occurrences).toEqual([
			{
				fieldSlug: "body",
				fieldPath: "body[1].images[0].asset._ref",
				occurrenceIndex: 0,
				referenceType: "portable_text_image",
				mediaId: "gallery-one",
				provider: "local",
				providerAssetId: "gallery-one",
				mediaKind: "image",
				mimeType: null,
			},
			{
				fieldSlug: "body",
				fieldPath: "body[1].images[1].asset.id",
				occurrenceIndex: 0,
				referenceType: "portable_text_image",
				mediaId: null,
				provider: "cloudflare-images",
				providerAssetId: "cf-two",
				mediaKind: "image",
				mimeType: "image/webp",
			},
		]);
	});

	it("counts an image used both in a gallery and as an image block as two uses", () => {
		const occurrences = extractMediaUsageOccurrences({
			fields: [field("body", "portableText")],
			data: {
				body: [
					{ _type: "image", _key: "img", asset: { _ref: "shared" } },
					{ _type: "gallery", _key: "g", images: [{ _key: "a", asset: { _ref: "shared" } }] },
				],
			},
		});

		expect(occurrences.map((occurrence) => occurrence.fieldPath)).toEqual([
			"body[0].asset._ref",
			"body[1].images[0].asset._ref",
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
						asset: { _ref: "https://example.com/photo.jpg" },
					},
				],
			},
		});

		expect(occurrences).toEqual([]);
	});

	it("keeps the storage key of rich text media named by a local file URL", () => {
		const occurrences = extractMediaUsageOccurrences({
			fields: [field("body", "portableText")],
			data: {
				body: [
					{ _type: "image", asset: { url: "/_emdash/api/media/file/01ABC.png" } },
					{
						_type: "image",
						asset: {
							_ref: "/_emdash/api/media/file/uploads/my%20photo.jpg?v=2",
							url: "/_emdash/api/media/file/uploads/my%20photo.jpg?v=2",
						},
					},
					{
						_type: "image",
						asset: { url: "/_emdash/api/media/file/01ABC.png", provider: "cloudflare-images" },
					},
					{
						_type: "image",
						asset: { url: "https://example.com/_emdash/api/media/file/01ABC.png" },
					},
				],
			},
		});

		expect(occurrences).toEqual([
			{
				fieldSlug: "body",
				fieldPath: "body[0].asset.url",
				occurrenceIndex: 0,
				referenceType: "portable_text_image",
				mediaId: null,
				provider: "local",
				providerAssetId: "01ABC.png",
				mediaKind: "image",
				mimeType: null,
				storageKey: "01ABC.png",
			},
			expect.objectContaining({
				fieldPath: "body[1].asset._ref",
				storageKey: "uploads/my photo.jpg",
			}),
		]);
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

	it("extracts media-file links from whole string and URL fields and Portable Text marks", () => {
		const occurrences = extractMediaUsageOccurrences({
			fields: [field("cta", "string"), field("download", "url"), field("body", "portableText")],
			data: {
				cta: "/_emdash/api/media/file/cta.pdf?download=1#top",
				download: "/_emdash/api/media/file/download.zip",
				body: [
					{
						_type: "block",
						_key: "p1",
						children: [{ _type: "span", text: "PDF" }],
						markDefs: [
							{ _key: "link1", _type: "link", href: "/_emdash/api/media/file/marked.pdf" },
						],
					},
				],
			},
		});

		expect(occurrences).toEqual([
			linkOccurrence("cta", "cta", "cta.pdf"),
			linkOccurrence("download", "download", "download.zip"),
			linkOccurrence("body", "body[0].markDefs[0].href", "marked.pdf"),
		]);
	});

	it("extracts href and src media links from HTML blocks", () => {
		const occurrences = extractMediaUsageOccurrences({
			fields: [field("body", "portableText")],
			data: {
				body: [
					{
						_type: "htmlBlock",
						_key: "html1",
						html: `<A HREF="/_emdash/api/media/file/first%20file.pdf?x=1&amp;y=2">first</A>
							<img SRC=/_emdash/api/media/file/second.png>
							<a href='/_emdash/api/media/file/first%20file.pdf'>duplicate</a>
							<a href="/_emdash/api/media/file/second.png">duplicate</a>`,
					},
				],
			},
		});

		expect(occurrences).toEqual([
			linkOccurrence("body", "body[0].html", "first file.pdf", 0),
			linkOccurrence("body", "body[0].html", "second.png", 1),
		]);
	});

	it("ignores non-media URLs, embedded prose, and malformed media URLs", () => {
		const occurrences = extractMediaUsageOccurrences({
			fields: [field("string", "string"), field("url", "url"), field("body", "portableText")],
			data: {
				string: "See /_emdash/api/media/file/embedded.pdf in this sentence",
				url: "https://example.com/_emdash/api/media/file/external.pdf",
				body: [
					{
						_type: "htmlBlock",
						_key: "html1",
						html: `<a href="/_emdash/api/media/file/%ZZ.pdf"></a>
							<a href="some/_emdash/api/media/file/relative.pdf"></a>
							<a href="//cdn.example.com/file.pdf"></a>`,
					},
				],
			},
		});

		expect(occurrences).toEqual([]);
	});

	it("extracts links from repeater string and URL subfields", () => {
		const occurrences = extractMediaUsageOccurrences({
			fields: [
				field("downloads", "repeater", {
					subFields: [
						{ slug: "label", type: "string" },
						{ slug: "href", type: "url" },
					],
				}),
			],
			data: {
				downloads: [
					{ label: "/_emdash/api/media/file/one.pdf", href: "/_emdash/api/media/file/two.pdf" },
					{ label: "not a URL", href: "/_emdash/api/media/file/three.pdf" },
				],
			},
		});

		expect(occurrences).toEqual([
			linkOccurrence("downloads", "downloads[0].label", "one.pdf"),
			linkOccurrence("downloads", "downloads[0].href", "two.pdf"),
			linkOccurrence("downloads", "downloads[1].href", "three.pdf"),
		]);
	});

	it("extracts links from block fields and nested repeater subfields", () => {
		const now = new Date().toISOString();
		const fields = [
			{
				slug: "content",
				type: "blocks" as const,
				blockTypes: [
					{
						id: "download-block",
						slug: "download-block",
						label: "Download block",
						currentVersion: 1,
						source: "user" as const,
						createdAt: now,
						updatedAt: now,
						versions: [
							{
								id: "download-block-v1",
								blockTypeId: "download-block",
								version: 1,
								fingerprint: "v1",
								active: true,
								createdAt: now,
								updatedAt: now,
								fields: [
									{ slug: "href", label: "Href", type: "url" as const },
									{
										slug: "items",
										label: "Items",
										type: "repeater" as const,
										validation: {
											subFields: [{ slug: "file", label: "File", type: "string" as const }],
										},
									},
								],
							},
						],
					},
				],
			},
		];
		const occurrences = extractMediaUsageOccurrences({
			fields,
			data: {
				content: [
					{
						_type: "download-block",
						_version: 1,
						_key: "download",
						href: "/_emdash/api/media/file/block.pdf",
						items: [{ file: "/_emdash/api/media/file/nested.pdf" }],
					},
				],
			},
		});

		expect(occurrences).toEqual([
			linkOccurrence("content", "content.download.href", "block.pdf"),
			linkOccurrence("content", "content.download.items[0].file", "nested.pdf"),
		]);
	});
});
