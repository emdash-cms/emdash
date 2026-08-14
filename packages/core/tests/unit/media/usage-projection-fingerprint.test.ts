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
	expect((await fingerprint({ occurrences: occurrences.toReversed() })).fingerprint).toBe(
		baseline.fingerprint,
	);
	expect((await fingerprint({ collectionId: "collection-2" })).fingerprint).not.toBe(
		baseline.fingerprint,
	);
	expect(
		(await fingerprint({ source: { ...source, contentTitle: "Changed title" } })).fingerprint,
	).not.toBe(baseline.fingerprint);
	expect(
		(
			await fingerprint({
				occurrences: [{ ...occurrences[0]!, mediaId: "changed-media" }, occurrences[1]!],
			})
		).fingerprint,
	).not.toBe(baseline.fingerprint);
	expect(
		(
			await fingerprint({
				extractionFields: [...extractionFields, { slug: "hero", type: "image" as const }],
			})
		).fingerprint,
	).not.toBe(baseline.fingerprint);
	expect(baseline.fingerprint).toMatch(/^media-usage-projection:v1:sha256:[a-f0-9]{64}$/);
	expect(baseline.byteLength).toBeGreaterThan(0);
});

it("returns the reused UTF-8 payload length with the fingerprint", async () => {
	const ascii = await fingerprint({ source: { ...source, contentTitle: "e" } });
	const multibyte = await fingerprint({ source: { ...source, contentTitle: "é" } });

	expect(multibyte.byteLength).toBe(ascii.byteLength + 1);
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
