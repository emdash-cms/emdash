import { normalizeMime } from "../mime.js";
import type {
	ExtractedMediaUsageOccurrence,
	ExtractMediaUsageOccurrencesInput,
	MediaKind,
	MediaUsageExtractionSubField,
	MediaUsageReferenceType,
} from "./types.js";

const INTERNAL_MEDIA_PREFIX = "/_emdash/api/media/file/";
const URL_LIKE_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

interface MediaRef {
	mediaId: string | null;
	provider: string;
	providerAssetId: string;
	mediaKind: MediaKind | null;
	mimeType: string | null;
}

interface AddOccurrenceInput {
	fieldSlug: string;
	fieldPath: string;
	referenceType: MediaUsageReferenceType;
	value: unknown;
	fallbackKind: MediaKind | null;
}

export function extractMediaUsageOccurrences({
	fields,
	data,
}: ExtractMediaUsageOccurrencesInput): ExtractedMediaUsageOccurrence[] {
	const occurrences: ExtractedMediaUsageOccurrence[] = [];
	const seen = new Set<string>();

	for (const field of fields) {
		const value = data[field.slug];

		if (field.type === "image") {
			addOccurrence(occurrences, seen, {
				fieldSlug: field.slug,
				fieldPath: field.slug,
				referenceType: "image_field",
				value,
				fallbackKind: "image",
			});
			continue;
		}

		if (field.type === "file") {
			addOccurrence(occurrences, seen, {
				fieldSlug: field.slug,
				fieldPath: field.slug,
				referenceType: "file_field",
				value,
				fallbackKind: null,
			});
			continue;
		}

		if (field.type === "repeater") {
			extractRepeaterOccurrences(occurrences, seen, field.slug, value, field.validation?.subFields);
			continue;
		}

		if (field.type === "portableText") {
			extractPortableTextOccurrences(occurrences, seen, field.slug, value);
		}
	}

	return occurrences;
}

function extractRepeaterOccurrences(
	occurrences: ExtractedMediaUsageOccurrence[],
	seen: Set<string>,
	fieldSlug: string,
	value: unknown,
	subFields: readonly MediaUsageExtractionSubField[] | undefined,
): void {
	if (!Array.isArray(value) || !Array.isArray(subFields)) return;

	for (const [itemIndex, item] of value.entries()) {
		if (!isRecord(item)) continue;

		for (const subField of subFields) {
			if (subField.type !== "image" && subField.type !== "file") continue;

			addOccurrence(occurrences, seen, {
				fieldSlug,
				fieldPath: `${fieldSlug}[${itemIndex}].${subField.slug}`,
				referenceType: subField.type === "image" ? "image_field" : "file_field",
				value: item[subField.slug],
				fallbackKind: subField.type === "image" ? "image" : null,
			});
		}
	}
}

function extractPortableTextOccurrences(
	occurrences: ExtractedMediaUsageOccurrence[],
	seen: Set<string>,
	fieldSlug: string,
	value: unknown,
): void {
	if (!Array.isArray(value)) return;

	for (const [blockIndex, block] of value.entries()) {
		if (!isRecord(block) || block._type !== "image" || !isRecord(block.asset)) continue;

		const provider = normalizeProvider(block.asset.provider);
		const ref = readPortableTextAssetRef(block.asset, provider);
		if (!ref) continue;

		addRefOccurrence(occurrences, seen, {
			fieldSlug,
			fieldPath: `${fieldSlug}[${blockIndex}].asset.${ref.key}`,
			referenceType: "portable_text_image",
			ref: buildMediaRef({
				id: ref.id,
				provider,
				mimeType: normalizeMimeValue(block.asset.mimeType),
				fallbackKind: "image",
			}),
		});
	}
}

function addOccurrence(
	occurrences: ExtractedMediaUsageOccurrence[],
	seen: Set<string>,
	input: AddOccurrenceInput,
): void {
	const ref = readMediaRef(input.value, input.fallbackKind);
	if (!ref) return;

	addRefOccurrence(occurrences, seen, {
		fieldSlug: input.fieldSlug,
		fieldPath: input.fieldPath,
		referenceType: input.referenceType,
		ref,
	});
}

function addRefOccurrence(
	occurrences: ExtractedMediaUsageOccurrence[],
	seen: Set<string>,
	input: {
		fieldSlug: string;
		fieldPath: string;
		referenceType: MediaUsageReferenceType;
		ref: MediaRef | null;
	},
): void {
	if (!input.ref) return;

	const occurrence: ExtractedMediaUsageOccurrence = {
		fieldSlug: input.fieldSlug,
		fieldPath: input.fieldPath,
		occurrenceIndex: 0,
		referenceType: input.referenceType,
		mediaId: input.ref.mediaId,
		provider: input.ref.provider,
		providerAssetId: input.ref.providerAssetId,
		mediaKind: input.ref.mediaKind,
		mimeType: input.ref.mimeType,
	};

	const key = [
		occurrence.fieldSlug,
		occurrence.fieldPath,
		occurrence.occurrenceIndex,
		occurrence.referenceType,
		occurrence.provider,
		occurrence.providerAssetId,
		occurrence.mediaId ?? "",
	].join("\0");

	if (seen.has(key)) return;
	seen.add(key);
	occurrences.push(occurrence);
}

function readMediaRef(value: unknown, fallbackKind: MediaKind | null): MediaRef | null {
	if (typeof value === "string") {
		const id = normalizeLocalMediaId(value);
		return id ? buildMediaRef({ id, provider: "local", mimeType: null, fallbackKind }) : null;
	}

	if (!isRecord(value)) return null;

	const provider = normalizeProvider(value.provider);
	const id = provider === "local" ? normalizeLocalMediaId(value.id) : normalizeStableId(value.id);
	if (!id) return null;

	return buildMediaRef({
		id,
		provider,
		mimeType: normalizeMimeValue(value.mimeType),
		fallbackKind,
	});
}

function buildMediaRef(input: {
	id: string;
	provider: string;
	mimeType: string | null;
	fallbackKind: MediaKind | null;
}): MediaRef | null {
	const provider = normalizeProvider(input.provider);
	if (provider === "external") return null;

	return {
		mediaId: provider === "local" ? input.id : null,
		provider,
		providerAssetId: input.id,
		mediaKind: mediaKindFromMime(input.mimeType) ?? input.fallbackKind,
		mimeType: input.mimeType,
	};
}

function readPortableTextAssetRef(
	asset: Record<string, unknown>,
	provider: string,
): { key: "_ref" | "id"; id: string } | null {
	const normalizeId = provider === "local" ? normalizeLocalMediaId : normalizeStableId;
	const ref = normalizeId(asset._ref);
	if (ref) return { key: "_ref", id: ref };

	const id = normalizeId(asset.id);
	if (id) return { key: "id", id };

	return null;
}

function normalizeProvider(value: unknown): string {
	const provider = readString(value)?.trim();
	return provider || "local";
}

function normalizeLocalMediaId(value: unknown): string | null {
	const id = normalizeStableId(value);
	if (!id) return null;
	return id.includes("/") ? null : id;
}

function normalizeStableId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (URL_LIKE_RE.test(trimmed)) return null;
	if (trimmed.startsWith(INTERNAL_MEDIA_PREFIX)) return null;
	return trimmed;
}

function normalizeMimeValue(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = normalizeMime(value);
	return normalized.includes("/") ? normalized : null;
}

function mediaKindFromMime(mimeType: string | null): MediaKind | null {
	if (!mimeType) return null;
	if (mimeType.startsWith("image/")) return "image";
	if (mimeType.startsWith("video/")) return "video";
	if (mimeType.startsWith("audio/")) return "audio";
	if (mimeType.startsWith("font/") || mimeType.startsWith("application/font-")) return "font";
	if (mimeType.startsWith("text/")) return "text";
	if (isDocumentMime(mimeType)) return "document";
	if (isArchiveMime(mimeType)) return "archive";
	return "other";
}

function isDocumentMime(mimeType: string): boolean {
	return (
		mimeType === "application/pdf" ||
		mimeType === "application/msword" ||
		mimeType === "application/rtf" ||
		mimeType === "application/vnd.ms-excel" ||
		mimeType === "application/vnd.ms-powerpoint" ||
		mimeType.startsWith("application/vnd.openxmlformats-officedocument.")
	);
}

function isArchiveMime(mimeType: string): boolean {
	return (
		mimeType === "application/zip" ||
		mimeType === "application/gzip" ||
		mimeType === "application/x-tar" ||
		mimeType === "application/x-7z-compressed" ||
		mimeType === "application/x-rar-compressed" ||
		mimeType === "application/vnd.rar"
	);
}

function readString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
