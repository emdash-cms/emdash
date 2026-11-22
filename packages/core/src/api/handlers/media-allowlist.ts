import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { expandExtensionShorthand, parseAllowedMimeTypes } from "../../media/mime.js";
import { BlockTypeRegistry } from "../../schema/block-type-registry.js";

/**
 * MIME types allowed for upload by default (when no field-specific list
 * overrides this). Entries ending with "/" are prefix-matched (e.g.
 * "video/" matches "video/mp4", "video/webm", etc.).
 *
 * Image types are enumerated explicitly rather than using a bare "image/"
 * prefix so that "image/svg+xml" is excluded by default: there is no
 * upload-time content validation for SVG, so an unvalidated bare-prefix
 * allowlist would let a Contributor+ upload an SVG with an embedded
 * `<script>`. Fields that genuinely need SVG uploads can still opt in via
 * their own `allowedMimeTypes` (see `resolveFieldAllowlist` below), which is
 * unaffected by this default.
 */
export const GLOBAL_UPLOAD_ALLOWLIST: readonly string[] = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/bmp",
	"image/jxl",
	"video/",
	"audio/",
	"application/pdf",
];

/**
 * Resolve the MIME allowlist for a specific field.
 *
 * Returns the field's `allowedMimeTypes` list when the field exists, is of
 * type "file" or "image", and has a non-empty list configured. Returns null
 * in all other cases — callers should fall back to GLOBAL_UPLOAD_ALLOWLIST.
 *
 * Composite IDs (`outerFieldId:blockKey:slug`) also require the block type
 * slug and retained version number. Only types configured on the outer blocks
 * field can supply an allowlist.
 *
 * Repeater image sub-fields append `.subFieldSlug` to the repeater field ID
 * (or to the final slug in a composite block field ID).
 *
 * Authentication is the caller's responsibility (the upload routes already
 * gate on `media:upload`).
 */
export async function resolveFieldAllowlist(
	db: Kysely<Database>,
	fieldId: string,
	blockType?: string,
	blockVersion?: number,
): Promise<string[] | null> {
	if (fieldId.includes(":")) {
		const parts = fieldId.split(":");
		const outerId = parts.shift();
		const slug = parts.pop();
		const blockKey = parts.join(":");
		if (
			!outerId ||
			!blockKey ||
			!slug ||
			!blockType ||
			!Number.isSafeInteger(blockVersion) ||
			!blockVersion ||
			blockVersion < 1
		)
			return null;

		const outer = await db
			.selectFrom("_emdash_fields")
			.select("validation")
			.where("id", "=", outerId)
			.where("type", "=", "blocks")
			.executeTakeFirst();
		if (!outer?.validation) return null;
		let validation: unknown;
		try {
			validation = JSON.parse(outer.validation);
		} catch {
			return null;
		}
		if (!validation || typeof validation !== "object" || Array.isArray(validation)) return null;
		const allowed =
			"allowedTypes" in validation && Array.isArray(validation.allowedTypes)
				? validation.allowedTypes
				: [];
		const retired =
			"retiredTypes" in validation && Array.isArray(validation.retiredTypes)
				? validation.retiredTypes
				: [];
		if (!allowed.includes(blockType) && !retired.includes(blockType)) return null;

		const type = await new BlockTypeRegistry(db).getBlockType(blockType);
		const version = type?.versions.find((candidate) => candidate.version === blockVersion);
		if (!version || version.unsupportedTypes?.length) return null;
		const [fieldSlug, subFieldSlug, ...extra] = slug.split(".");
		if (extra.length || subFieldSlug === "") return null;
		const field = version.fields.find((candidate) => candidate.slug === fieldSlug);
		return field
			? mediaFieldAllowlist(field.type, JSON.stringify(field.validation), subFieldSlug)
			: null;
	}

	const [outerId, subFieldSlug, ...extra] = fieldId.split(".");
	if (!outerId || extra.length || subFieldSlug === "") return null;
	const row = await db
		.selectFrom("_emdash_fields")
		.select(["type", "validation"])
		.where("id", "=", outerId)
		.executeTakeFirst();

	return row ? mediaFieldAllowlist(row.type, row.validation, subFieldSlug) : null;
}

function parseNestedMimeAllowlist(validation: unknown): string[] | null {
	if (!validation || typeof validation !== "object" || Array.isArray(validation)) return null;
	const raw = "allowedMimeTypes" in validation ? validation.allowedMimeTypes : undefined;
	if (!Array.isArray(raw) || raw.length === 0 || raw.some((entry) => typeof entry !== "string")) {
		return null;
	}
	const parsed = parseAllowedMimeTypes(JSON.stringify(validation));
	return parsed?.length === raw.length &&
		raw.every((entry) => entry.includes("/") && expandExtensionShorthand(entry) === entry)
		? parsed
		: null;
}

function mediaFieldAllowlist(
	type: string,
	validation: string | null | undefined,
	subFieldSlug?: string,
): string[] | null {
	if (subFieldSlug !== undefined) {
		if (type !== "repeater" || !validation) return null;
		try {
			const parsed: unknown = JSON.parse(validation);
			if (
				!parsed ||
				typeof parsed !== "object" ||
				!("subFields" in parsed) ||
				!Array.isArray(parsed.subFields)
			)
				return null;
			const field: unknown = parsed.subFields.find(
				(candidate: unknown) =>
					candidate !== null &&
					typeof candidate === "object" &&
					"slug" in candidate &&
					candidate.slug === subFieldSlug,
			);
			if (
				!field ||
				typeof field !== "object" ||
				!("type" in field) ||
				field.type !== "image" ||
				!("validation" in field)
			)
				return null;
			return parseNestedMimeAllowlist(field.validation);
		} catch {
			return null;
		}
	}
	return type === "image" || type === "file" ? parseAllowedMimeTypes(validation) : null;
}
