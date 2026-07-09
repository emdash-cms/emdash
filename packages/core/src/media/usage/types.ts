import type { FieldType } from "../../schema/types.js";

export type MediaKind =
	| "image"
	| "video"
	| "audio"
	| "document"
	| "archive"
	| "font"
	| "text"
	| "other";

export type MediaUsageReferenceType = "image_field" | "file_field" | "portable_text_image";

export interface MediaUsageExtractionSubField {
	slug: string;
	type: FieldType;
	label?: string;
}

export interface MediaUsageExtractionValidation {
	subFields?: readonly MediaUsageExtractionSubField[];
}

export interface MediaUsageExtractionField {
	slug: string;
	type: FieldType;
	validation?: MediaUsageExtractionValidation | null;
}

export interface ExtractMediaUsageOccurrencesInput {
	fields: readonly MediaUsageExtractionField[];
	data: Record<string, unknown>;
}

export interface ExtractedMediaUsageOccurrence {
	fieldSlug: string;
	fieldPath: string;
	occurrenceIndex: number;
	referenceType: MediaUsageReferenceType;
	mediaId: string | null;
	provider: string;
	providerAssetId: string;
	mediaKind: MediaKind | null;
	mimeType: string | null;
}
