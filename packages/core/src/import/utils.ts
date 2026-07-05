/**
 * Shared import utilities
 *
 * Common constants and functions used across all WordPress import sources.
 */

import mime from "mime/lite";

import { RESERVED_FIELD_SLUGS } from "../schema/types.js";
import type { ImportFieldDef, CollectionSchemaStatus } from "./types.js";

// =============================================================================
// Constants
// =============================================================================

/** Internal WordPress post types that should be excluded from import */
export const INTERNAL_POST_TYPES = [
	"revision",
	"nav_menu_item",
	"custom_css",
	"customize_changeset",
	"oembed_cache",
	"wp_global_styles",
	"wp_navigation",
	"wp_template",
	"wp_template_part",
	"attachment", // Handled separately as media
	"wp_block", // Handled separately as sections (reusable blocks)
];

/** Internal meta key prefixes to filter out */
export const INTERNAL_META_PREFIXES = ["_edit_", "_wp_"];

const NUMERIC_PATTERN = /^-?\d+(\.\d+)?$/;
const TRAILING_SLASHES = /\/+$/;
const WP_JSON_SUFFIX = /\/wp-json\/?.*$/;

/** Specific internal meta keys */
export const INTERNAL_META_KEYS = ["_edit_last", "_edit_lock", "_pingme", "_encloseme"];

/** Base fields required for any WordPress import */
export const BASE_REQUIRED_FIELDS: ImportFieldDef[] = [
	{ slug: "title", label: "Title", type: "string", required: true, searchable: true },
	{ slug: "content", label: "Content", type: "portableText", required: false, searchable: true },
	{ slug: "excerpt", label: "Excerpt", type: "text", required: false },
];

/** Featured image field - only added to post types that have _thumbnail_id */
export const FEATURED_IMAGE_FIELD: ImportFieldDef = {
	slug: "featured_image",
	label: "Featured Image",
	type: "image",
	required: false,
};

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if a post type is internal/should be excluded
 */
export function isInternalPostType(type: string): boolean {
	return INTERNAL_POST_TYPES.includes(type);
}

/**
 * Check if a meta key is internal/should be filtered out
 */
export function isInternalMetaKey(key: string): boolean {
	// Check specific keys
	if (INTERNAL_META_KEYS.includes(key)) return true;

	// Check prefixes
	for (const prefix of INTERNAL_META_PREFIXES) {
		if (key.startsWith(prefix)) return true;
	}

	// Keep these useful ones
	if (key === "_thumbnail_id") return false;
	if (key.startsWith("_yoast_")) return false;
	if (key.startsWith("_rank_math_")) return false;

	// Other underscore prefixes are usually internal
	if (key.startsWith("_")) return true;

	return false;
}

// =============================================================================
// Status Mapping
// =============================================================================

/** Valid WordPress statuses */
export type WpStatus = "publish" | "draft" | "pending" | "private" | "future";

/**
 * Map WordPress status to normalized status
 */
export function mapWpStatus(status: string | undefined): WpStatus {
	switch (status) {
		case "publish":
			return "publish";
		case "draft":
			return "draft";
		case "pending":
			return "pending";
		case "private":
			return "private";
		case "future":
			return "future";
		default:
			return "draft";
	}
}

// =============================================================================
// Collection Mapping
// =============================================================================

/** Default mappings from WordPress post types to EmDash collections */
const POST_TYPE_TO_COLLECTION: Record<string, string> = {
	post: "posts",
	page: "pages",
	attachment: "media",
	product: "products",
	portfolio: "portfolio",
	testimonial: "testimonials",
	team: "team",
	event: "events",
	faq: "faqs",
};

/**
 * Map WordPress post type to EmDash collection name
 */
export function mapPostTypeToCollection(postType: string): string {
	return POST_TYPE_TO_COLLECTION[postType] || postType;
}

// =============================================================================
// Meta Key Mapping
// =============================================================================

/**
 * Map WordPress meta key to EmDash field slug
 */
export function mapMetaKeyToField(key: string): string {
	// SEO plugins
	if (key === "_yoast_wpseo_title") return "seo_title";
	if (key === "_yoast_wpseo_metadesc") return "seo_description";
	if (key === "_rank_math_title") return "seo_title";
	if (key === "_rank_math_description") return "seo_description";
	if (key === "_thumbnail_id") return "featured_image";

	// Remove leading underscore
	if (key.startsWith("_")) return key.slice(1);

	return key;
}

/**
 * Infer field type from meta key name and sample value
 */
export function inferMetaType(
	key: string,
	value: string | undefined,
): "string" | "number" | "boolean" | "date" | "json" {
	if (key.endsWith("_id") || key === "_thumbnail_id") return "string";
	if (key.endsWith("_date") || key.endsWith("_time")) return "date";
	if (key.endsWith("_count") || key.endsWith("_number")) return "number";

	if (!value) return "string";

	// Serialized PHP or JSON
	if (value.startsWith("a:") || value.startsWith("{") || value.startsWith("[")) return "json";

	// Number
	if (NUMERIC_PATTERN.test(value)) return "number";

	// Boolean
	if (["0", "1", "true", "false"].includes(value)) return "boolean";

	return "string";
}

// =============================================================================
// Field Slug Sanitization
// =============================================================================

const INVALID_FIELD_SLUG_CHARS = /[^a-z0-9_]+/g;
const LEADING_NON_ALPHA_CHARS = /^[^a-z]+/;

/**
 * Sanitize a WordPress meta/ACF key into a valid EmDash field slug
 * (`/^[a-z][a-z0-9_]*$/`, max 63 chars, not reserved).
 *
 * Must be applied consistently on both sides of an import: once when
 * creating fields from the analysis, and again when matching incoming
 * meta keys onto schema fields — otherwise keys like `my-field` create
 * `my_field` but never receive values.
 */
export function sanitizeFieldSlug(key: string): string {
	const sanitized = key
		.toLowerCase()
		.replace(INVALID_FIELD_SLUG_CHARS, "_")
		.replace(LEADING_NON_ALPHA_CHARS, "")
		.slice(0, 63);
	if (!sanitized) return "field";
	if (RESERVED_FIELD_SLUGS.includes(sanitized)) return `wp_${sanitized}`;
	return sanitized;
}

// =============================================================================
// String Utilities
// =============================================================================

export { slugify } from "../utils/slugify.js";

/**
 * Normalize URL for API requests
 */
export function normalizeUrl(url: string): string {
	let normalized = url.trim();

	// Add protocol if missing
	if (!normalized.startsWith("http")) {
		normalized = `https://${normalized}`;
	}

	// Remove trailing slash
	normalized = normalized.replace(TRAILING_SLASHES, "");

	// Remove /wp-json if included
	normalized = normalized.replace(WP_JSON_SUFFIX, "");

	return normalized;
}

// =============================================================================
// File Utilities
// =============================================================================

/**
 * Extract filename from URL
 */
export function getFilenameFromUrl(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		const segments = parsed.pathname.split("/").filter(Boolean);
		return segments.pop();
	} catch {
		return undefined;
	}
}

/**
 * Guess MIME type from filename
 */
export function guessMimeType(filename: string): string | undefined {
	return mime.getType(filename) ?? undefined;
}

// =============================================================================
// Attachment Map Builder
// =============================================================================

/**
 * Build a map of attachment IDs to URLs for resolving featured images
 */
export function buildAttachmentMap(
	attachments: Array<{ id?: number | string; url?: string }>,
): Map<string, string> {
	const map = new Map<string, string>();
	for (const att of attachments) {
		if (att.id && att.url) {
			map.set(String(att.id), att.url);
		}
	}
	return map;
}

// =============================================================================
// Schema Compatibility
// =============================================================================

/**
 * Check if two field types are compatible for import
 */
export function isTypeCompatible(requiredType: string, existingType: string): boolean {
	if (requiredType === existingType) return true;

	const compatibleTypes: Record<string, string[]> = {
		string: ["string", "text", "slug"],
		text: ["string", "text"],
		portableText: ["portableText", "json"],
		number: ["number", "integer"],
		integer: ["number", "integer"],
	};

	const compatible = compatibleTypes[requiredType];
	return compatible?.includes(existingType) ?? false;
}

// =============================================================================
// Byline Import Utilities
// =============================================================================

import type { BylineRepository } from "../database/repositories/byline.js";
import { slugify as slugifyFn } from "../utils/slugify.js";

const MAX_SLUG_COLLISION_ATTEMPTS = 1000;

/**
 * Find or create a unique byline slug, capped at MAX_SLUG_COLLISION_ATTEMPTS.
 */
export async function ensureUniqueBylineSlug(
	bylineRepo: BylineRepository,
	baseSlug: string,
): Promise<string> {
	let candidate = baseSlug;
	let suffix = 2;
	while (await bylineRepo.findBySlug(candidate)) {
		if (suffix > MAX_SLUG_COLLISION_ATTEMPTS) {
			throw new Error(
				`Byline slug collision limit exceeded for base slug "${baseSlug}". ` +
					`Tried ${MAX_SLUG_COLLISION_ATTEMPTS} variants.`,
			);
		}
		candidate = `${baseSlug}-${suffix}`;
		suffix++;
	}
	return candidate;
}

/**
 * Resolve (find-or-create) a byline for an imported WordPress author.
 * Caches results in `cache` keyed by `authorLogin:mappedUserId`.
 */
export async function resolveImportByline(
	authorLogin: string | undefined,
	displayName: string | undefined,
	mappedUserId: string | undefined,
	bylineRepo: BylineRepository,
	cache: Map<string, string>,
): Promise<string | undefined> {
	if (!authorLogin) return undefined;
	const cacheKey = `${authorLogin}:${mappedUserId ?? ""}`;
	const cached = cache.get(cacheKey);
	if (cached) return cached;

	if (mappedUserId) {
		const existingForUser = await bylineRepo.findByUserId(mappedUserId);
		if (existingForUser) {
			cache.set(cacheKey, existingForUser.id);
			return existingForUser.id;
		}
	}

	const name = displayName || authorLogin;
	const slugBase = slugifyFn(authorLogin);
	const slug = await ensureUniqueBylineSlug(bylineRepo, slugBase || "author");
	const created = await bylineRepo.create({
		slug,
		displayName: name,
		userId: mappedUserId ?? null,
		isGuest: !mappedUserId,
	});

	cache.set(cacheKey, created.id);
	return created.id;
}

// =============================================================================
// Schema Compatibility
// =============================================================================

/**
 * Check schema compatibility between required fields and existing collection
 */
export function checkSchemaCompatibility(
	requiredFields: ImportFieldDef[],
	existingCollection: { slug: string; fields: Map<string, { type: string }> } | undefined,
): CollectionSchemaStatus {
	if (!existingCollection) {
		// Collection doesn't exist - will need to create it
		const fieldStatus: CollectionSchemaStatus["fieldStatus"] = {};
		for (const field of requiredFields) {
			fieldStatus[field.slug] = {
				status: "missing",
				requiredType: field.type,
			};
		}
		return {
			exists: false,
			fieldStatus,
			canImport: true,
		};
	}

	// Collection exists - check field compatibility
	const fieldStatus: CollectionSchemaStatus["fieldStatus"] = {};
	const incompatibleFields: string[] = [];

	for (const field of requiredFields) {
		const existingField = existingCollection.fields.get(field.slug);

		if (!existingField) {
			fieldStatus[field.slug] = {
				status: "missing",
				requiredType: field.type,
			};
		} else if (isTypeCompatible(field.type, existingField.type)) {
			fieldStatus[field.slug] = {
				status: "compatible",
				existingType: existingField.type,
				requiredType: field.type,
			};
		} else {
			fieldStatus[field.slug] = {
				status: "type_mismatch",
				existingType: existingField.type,
				requiredType: field.type,
			};
			incompatibleFields.push(field.slug);
		}
	}

	const canImport = incompatibleFields.length === 0;
	const reason = canImport
		? undefined
		: `Incompatible field types: ${incompatibleFields.join(", ")}`;

	return {
		exists: true,
		fieldStatus,
		canImport,
		reason,
	};
}
