import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import { buildCanonicalSha256Fingerprint } from "./projection-fingerprint.js";
import type { MediaUsageExtractionField, MediaUsageExtractionSubField } from "./types.js";
import { CONTENT_SOURCE_SCHEMA_VERSION } from "./types.js";

export type ContentMediaUsageField = MediaUsageExtractionField;

export interface ContentMediaUsageFieldDiscovery {
	extractionFields: ContentMediaUsageField[];
	displayFieldSlugs: string[];
}

export async function buildContentMediaUsageFieldFingerprint(
	discovery: ContentMediaUsageFieldDiscovery,
): Promise<string> {
	const extractionFields = discovery.extractionFields
		.map((field) => ({
			slug: field.slug,
			type: field.type,
			...(field.type === "repeater"
				? {
						subFields: (field.validation?.subFields ?? [])
							.map((subField) => ({ slug: subField.slug, type: subField.type }))
							.toSorted(compareFieldIdentity),
					}
				: {}),
		}))
		.toSorted(compareFieldIdentity);
	const result = await buildCanonicalSha256Fingerprint("media-usage-fields:v1:sha256:", {
		fingerprintVersion: 1,
		contentSourceSchemaVersion: CONTENT_SOURCE_SCHEMA_VERSION,
		extractionFields,
		displayFieldSlugs: discovery.displayFieldSlugs.toSorted(compareStrings),
	});
	return result.fingerprint;
}

export class MediaUsageFieldDiscoveryError extends Error {
	constructor(
		message: string,
		public code: "INVALID_REPEATER_VALIDATION",
	) {
		super(message);
		this.name = "MediaUsageFieldDiscoveryError";
	}
}

interface FieldDiscoveryRow {
	slug: string;
	type: string;
	validation: string | null;
}

const DISPLAY_FIELD_SLUGS = ["title", "name"] as const;
const SUPPORTED_TOP_LEVEL_TYPES = ["file", "image", "portableText"] as const;

type SupportedTopLevelType = (typeof SUPPORTED_TOP_LEVEL_TYPES)[number];

export async function loadContentMediaUsageFields(
	db: Kysely<Database>,
	collectionSlug: string,
	collectionId?: string,
): Promise<ContentMediaUsageFieldDiscovery> {
	validateIdentifier(collectionSlug, "collection slug");

	let query = db
		.selectFrom("_emdash_fields")
		.innerJoin("_emdash_collections", "_emdash_collections.id", "_emdash_fields.collection_id")
		.select(["_emdash_fields.slug", "_emdash_fields.type", "_emdash_fields.validation"])
		.where("_emdash_collections.slug", "=", collectionSlug);
	if (collectionId !== undefined) query = query.where("_emdash_collections.id", "=", collectionId);
	const rows = await query.execute();

	const extractionFields: ContentMediaUsageField[] = [];
	const rowBySlug = new Map<string, FieldDiscoveryRow>();

	for (const row of rows) {
		rowBySlug.set(row.slug, row);
		if (isSupportedTopLevelType(row.type)) {
			validateIdentifier(row.slug, "media usage field slug");
			extractionFields.push({ slug: row.slug, type: row.type });
			continue;
		}

		if (row.type === "repeater") {
			validateIdentifier(row.slug, "media usage field slug");
			const subFields = normalizeRepeaterImageSubFields(row.validation);
			if (subFields.length > 0) {
				extractionFields.push({
					slug: row.slug,
					type: "repeater",
					validation: { subFields },
				});
			}
		}
	}

	extractionFields.sort((a, b) => a.slug.localeCompare(b.slug));

	return {
		extractionFields,
		displayFieldSlugs: DISPLAY_FIELD_SLUGS.filter((slug) => {
			if (!rowBySlug.has(slug)) return false;
			validateIdentifier(slug, "media usage display field slug");
			return true;
		}),
	};
}

function normalizeRepeaterImageSubFields(
	rawValidation: string | null,
): MediaUsageExtractionSubField[] {
	const validation = parseValidation(rawValidation);
	if (!isRecord(validation) || !Array.isArray(validation.subFields)) return [];

	const subFields: MediaUsageExtractionSubField[] = [];
	for (const subField of validation.subFields) {
		if (!isRecord(subField) || subField.type !== "image") continue;
		if (typeof subField.slug !== "string") continue;
		validateIdentifier(subField.slug, "media usage repeater sub-field slug");
		subFields.push({ slug: subField.slug, type: "image" });
	}

	return subFields.toSorted((a, b) => a.slug.localeCompare(b.slug));
}

function parseValidation(rawValidation: string | null): unknown {
	if (!rawValidation) return null;
	try {
		return JSON.parse(rawValidation);
	} catch {
		throw new MediaUsageFieldDiscoveryError(
			"Repeater field validation must be valid JSON before media usage can be discovered",
			"INVALID_REPEATER_VALIDATION",
		);
	}
}

function isSupportedTopLevelType(value: string): value is SupportedTopLevelType {
	return (SUPPORTED_TOP_LEVEL_TYPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareFieldIdentity(a: { slug: string }, b: { slug: string }): number {
	return compareStrings(a.slug, b.slug);
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
