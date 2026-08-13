import type {
	MediaUsageOccurrenceInput,
	MediaUsageSourceInput,
} from "../../database/repositories/media-usage.js";
import type { MediaUsageExtractionField } from "./types.js";

export const MEDIA_USAGE_PROJECTION_FINGERPRINT_VERSION = 1;
const FINGERPRINT_PREFIX = `media-usage-projection:v${MEDIA_USAGE_PROJECTION_FINGERPRINT_VERSION}:sha256:`;
const FINGERPRINT_PATTERN = new RegExp(`^${FINGERPRINT_PREFIX}[a-f0-9]{64}$`);

export interface MediaUsageProjectionFingerprintInput {
	collectionId: string;
	source: MediaUsageSourceInput;
	occurrences: readonly MediaUsageOccurrenceInput[];
	extractionFields: readonly MediaUsageExtractionField[];
}

export interface MediaUsageProjectionFingerprint {
	fingerprint: string;
	byteLength: number;
}

export async function buildMediaUsageProjectionFingerprint(
	input: MediaUsageProjectionFingerprintInput,
): Promise<MediaUsageProjectionFingerprint> {
	if (!input.collectionId) {
		throw new Error("Media usage projection fingerprints require a collection identity");
	}
	const canonicalOccurrences = input.occurrences
		.map((occurrence) => ({
			fieldSlug: occurrence.fieldSlug,
			fieldPath: occurrence.fieldPath,
			occurrenceIndex: occurrence.occurrenceIndex ?? 0,
			referenceType: occurrence.referenceType,
			mediaId: occurrence.mediaId,
			provider: occurrence.provider,
			providerAssetId: occurrence.providerAssetId,
			mediaKind: occurrence.mediaKind ?? null,
			mimeType: occurrence.mimeType ?? null,
		}))
		.map((occurrence) => ({ occurrence, key: canonicalJson(occurrence) }))
		.toSorted((a, b) => compareCanonicalStrings(a.key, b.key))
		.map(({ occurrence }) => occurrence);
	return buildCanonicalSha256Fingerprint(FINGERPRINT_PREFIX, {
		fingerprintVersion: MEDIA_USAGE_PROJECTION_FINGERPRINT_VERSION,
		collectionId: input.collectionId,
		extractionSchema: normalizeExtractionFields(input.extractionFields),
		source: {
			sourceKey: input.source.sourceKey,
			sourceType: input.source.sourceType,
			collectionSlug: input.source.collectionSlug ?? null,
			contentId: input.source.contentId ?? null,
			sourceVariant: input.source.sourceVariant,
			locale: input.source.locale ?? null,
			translationGroup: input.source.translationGroup ?? null,
			contentSlug: input.source.contentSlug ?? null,
			contentTitle: input.source.contentTitle ?? null,
			contentStatus: input.source.contentStatus ?? null,
			contentScheduledAt: input.source.contentScheduledAt ?? null,
			contentDeletedAt: input.source.contentDeletedAt ?? null,
			revisionId: input.source.revisionId ?? null,
			schemaVersion: input.source.schemaVersion ?? 1,
			sourceCompleteness: input.source.sourceCompleteness ?? "complete",
		},
		occurrences: canonicalOccurrences,
	});
}

export async function buildCanonicalSha256Fingerprint(
	prefix: string,
	payload: unknown,
): Promise<MediaUsageProjectionFingerprint> {
	const encodedPayload = new TextEncoder().encode(canonicalJson(payload));
	const digest = await crypto.subtle.digest("SHA-256", encodedPayload);
	const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
	return {
		fingerprint: `${prefix}${hex}`,
		byteLength: encodedPayload.byteLength,
	};
}

function normalizeExtractionFields(
	fields: readonly MediaUsageExtractionField[],
): Record<string, unknown>[] {
	return fields
		.map((field) => {
			if (field.type !== "repeater") return { slug: field.slug, type: field.type };
			return {
				slug: field.slug,
				type: field.type,
				subFields: (field.validation?.subFields ?? [])
					.map((subField) => ({ slug: subField.slug, type: subField.type }))
					.toSorted((a, b) => compareCanonicalStrings(a.slug, b.slug)),
			};
		})
		.toSorted((a, b) => compareCanonicalStrings(String(a.slug), String(b.slug)));
}

function compareCanonicalStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export function isMediaUsageProjectionFingerprint(value: string | null | undefined): boolean {
	return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (value === undefined) return null;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (Array.isArray(value)) return value.map((item) => canonicalize(item));
	if (!isRecord(value)) return value;

	const canonical: Record<string, unknown> = {};
	for (const key of Object.keys(value).toSorted()) {
		canonical[key] = canonicalize(value[key]);
	}
	return canonical;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
