import type { FieldType, FieldValidation } from "../schema/types.js";
import { mediaKindFromMime, normalizeMime, type MediaKind } from "./mime.js";
import { INTERNAL_MEDIA_PREFIX } from "./normalize.js";

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export type MediaUsageReferenceType =
	| "image_field"
	| "file_field"
	| "repeater_image_subfield"
	| "portable_text_image";

export interface ExtractedMediaUsage {
	mediaId: string | null;
	provider: string;
	providerAssetId: string;
	mediaKind: MediaKind | null;
	mimeType: string | null;
	referenceType: MediaUsageReferenceType;
	fieldPath: string;
}

export interface MediaUsageIndexedField {
	slug: string;
	type: FieldType;
	validation?: FieldValidation | null;
}

export function extractContentMediaUsage(
	fields: readonly MediaUsageIndexedField[],
	data: Record<string, unknown>,
): ExtractedMediaUsage[] {
	const refs: ExtractedMediaUsage[] = [];

	for (const field of fields) {
		const value = data[field.slug];
		if (value == null) continue;

		switch (field.type) {
			case "image":
				pushMediaValueRef(refs, value, "image_field", field.slug, "image");
				break;
			case "file":
				pushMediaValueRef(refs, value, "file_field", field.slug, null);
				break;
			case "repeater":
				extractRepeaterRefs(refs, field, value);
				break;
			case "portableText":
				extractPortableTextRefs(refs, value, field.slug);
				break;
		}
	}

	return dedupeRefs(refs);
}

function extractRepeaterRefs(
	refs: ExtractedMediaUsage[],
	field: MediaUsageIndexedField,
	value: unknown,
) {
	if (!Array.isArray(value)) return;
	const imageSubFields = field.validation?.subFields?.filter(
		(subField) => subField.type === "image",
	);
	if (!imageSubFields?.length) return;

	for (const [index, item] of value.entries()) {
		if (!isRecord(item)) continue;
		for (const subField of imageSubFields) {
			pushMediaValueRef(
				refs,
				item[subField.slug],
				"repeater_image_subfield",
				`${field.slug}[${index}].${subField.slug}`,
				"image",
			);
		}
	}
}

function extractPortableTextRefs(refs: ExtractedMediaUsage[], value: unknown, path: string) {
	if (Array.isArray(value)) {
		value.forEach((item, index) => extractPortableTextRefs(refs, item, `${path}[${index}]`));
		return;
	}

	if (!isRecord(value)) return;

	if (value._type === "image") {
		const ref = getPortableTextImageRef(value);
		if (ref) {
			const { fieldKey, ...target } = ref;
			refs.push({
				...target,
				referenceType: "portable_text_image",
				fieldPath: `${path}.asset.${fieldKey}`,
			});
		}
	}

	for (const [key, child] of Object.entries(value)) {
		if (key === "asset" && value._type === "image") continue;
		extractPortableTextRefs(refs, child, `${path}.${key}`);
	}
}

function getPortableTextImageRef(
	block: Record<string, unknown>,
): (ExtractedMediaTarget & { fieldKey: string }) | null {
	const asset = block.asset;
	if (!isRecord(asset)) return null;

	const fieldKey = typeof asset._ref === "string" ? "_ref" : "id";
	const value =
		fieldKey === "_ref" ? { ...asset, id: asset._ref, mimeType: asset.mimeType } : asset;
	const ref = getMediaValueTarget(value, "image");
	if (!ref) return null;
	return { ...ref, fieldKey };
}

interface ExtractedMediaTarget {
	mediaId: string | null;
	provider: string;
	providerAssetId: string;
	mediaKind: MediaKind | null;
	mimeType: string | null;
}

function pushMediaValueRef(
	refs: ExtractedMediaUsage[],
	value: unknown,
	referenceType: MediaUsageReferenceType,
	fieldPath: string,
	fallbackKind: MediaKind | null,
) {
	const target = getMediaValueTarget(value, fallbackKind);
	if (!target) return;
	refs.push({ ...target, referenceType, fieldPath });
}

function getMediaValueTarget(
	value: unknown,
	fallbackKind: MediaKind | null,
): ExtractedMediaTarget | null {
	if (typeof value === "string") {
		if (!isLocalMediaId(value)) return null;
		return {
			mediaId: value,
			provider: "local",
			providerAssetId: value,
			mediaKind: fallbackKind,
			mimeType: null,
		};
	}

	if (!isRecord(value)) return null;

	const provider = getProvider(value.provider);
	const id = value.id;
	if (typeof id !== "string" || !isStructuredAssetId(id)) return null;
	if (provider === "local" && !isLocalMediaId(id)) return null;

	const mimeType = typeof value.mimeType === "string" ? normalizeMime(value.mimeType) : null;
	return {
		mediaId: provider === "local" ? id : null,
		provider,
		providerAssetId: id,
		mediaKind: mediaKindFromMime(mimeType) ?? fallbackKind,
		mimeType,
	};
}

function getProvider(value: unknown): string {
	if (typeof value !== "string") return "local";
	const provider = value.trim();
	return provider.length > 0 ? provider : "local";
}

function isLocalMediaId(value: string): boolean {
	return isStructuredAssetId(value) && !value.startsWith(INTERNAL_MEDIA_PREFIX);
}

function isStructuredAssetId(value: string): boolean {
	return value.length > 0 && !isUrl(value) && !value.startsWith(INTERNAL_MEDIA_PREFIX);
}

function isUrl(value: string): boolean {
	return URL_SCHEME_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupeRefs(refs: ExtractedMediaUsage[]): ExtractedMediaUsage[] {
	const seen = new Set<string>();
	const deduped: ExtractedMediaUsage[] = [];
	for (const ref of refs) {
		const key = `${ref.fieldPath}\0${ref.provider}\0${ref.providerAssetId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(ref);
	}
	return deduped;
}
