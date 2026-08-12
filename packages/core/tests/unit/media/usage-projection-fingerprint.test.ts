import { expect, it } from "vitest";

import { buildMediaUsageProjectionFingerprint } from "../../../src/media/usage/projection-fingerprint.js";

const source = {
	sourceKey: "content:posts:entry-1:columns",
	sourceType: "content",
	collectionSlug: "posts",
	contentId: "entry-1",
	sourceVariant: "columns" as const,
	locale: "en",
	translationGroup: "translation-1",
	contentSlug: "entry-1",
	contentTitle: "Entry 1",
	contentStatus: "published",
	contentScheduledAt: null,
	contentDeletedAt: null,
	revisionId: null,
	schemaVersion: 1,
};
const occurrences = [
	{
		fieldSlug: "gallery",
		fieldPath: "gallery[1]",
		occurrenceIndex: 1,
		referenceType: "image_field" as const,
		mediaId: "media-2",
		provider: "local",
		providerAssetId: "media-2",
		mediaKind: "image" as const,
		mimeType: "image/webp",
	},
	{
		fieldSlug: "gallery",
		fieldPath: "gallery[0]",
		occurrenceIndex: 0,
		referenceType: "image_field" as const,
		mediaId: "media-1",
		provider: "local",
		providerAssetId: "media-1",
		mediaKind: "image" as const,
		mimeType: "image/webp",
	},
];
const extractionFields = [{ slug: "gallery", type: "image" as const }];

it("is order-independent but changes for every projection input class", async () => {
	const baseline = await fingerprint();
	expect(await fingerprint({ occurrences: occurrences.toReversed() })).toBe(baseline);
	expect(await fingerprint({ collectionId: "collection-2" })).not.toBe(baseline);
	expect(await fingerprint({ source: { ...source, contentTitle: "Changed title" } })).not.toBe(
		baseline,
	);
	expect(
		await fingerprint({
			occurrences: [{ ...occurrences[0]!, mediaId: "changed-media" }, occurrences[1]!],
		}),
	).not.toBe(baseline);
	expect(
		await fingerprint({
			extractionFields: [...extractionFields, { slug: "hero", type: "image" as const }],
		}),
	).not.toBe(baseline);
});

it("refuses to mint a current fingerprint without immutable collection identity", async () => {
	await expect(fingerprint({ collectionId: "" })).rejects.toThrow(/collection identity/i);
});

function fingerprint(
	overrides: Partial<Parameters<typeof buildMediaUsageProjectionFingerprint>[0]> = {},
) {
	return buildMediaUsageProjectionFingerprint({
		collectionId: "collection-1",
		source,
		occurrences,
		extractionFields,
		...overrides,
	});
}
