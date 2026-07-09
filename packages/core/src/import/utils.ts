/**
 * Shared import utilities
 *
 * Common constants and functions used across all WordPress import sources.
 */

import type { PortableTextBlock } from "@emdash-cms/gutenberg-to-portable-text";
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
// Plugin Bookkeeping Meta
// =============================================================================

/**
 * Meta prefixes written by well-known WordPress plugins as operational
 * bookkeeping (sync state, counters, cache keys) — not content. Without
 * this filter, a mature site's analysis suggests dozens of junk fields
 * per post type and the real content fields drown in them.
 *
 * ponytail: curated list of the plugins we've seen in the wild, not a
 * taxonomy of the WP ecosystem. Unknown plugins' meta still gets through;
 * extend the list as real sites surface new offenders.
 */
const PLUGIN_META_PREFIXES = [
	"aawp_", // AAWP (Amazon affiliate)
	"algolia_", // Algolia / WP Search with Algolia
	"amazon_polly_", // Amazon Polly
	"ampforwp_", // AMP for WP
	"classifai_", // ClassifAI
	"essb_", // Easy Social Share Buttons
	"eg_", // Essential Grid
	"gnpub_", // Google News publisher tools
	"jetpack_", // Jetpack
	"mashsb_", // MashShare
	"monsterinsights_", // MonsterInsights
	"onesignal_", // OneSignal push
	"penci_", // Penci themes
	"perfmatters_", // Perfmatters
	"pys_", // PixelYourSite
	"rank_math_", // Rank Math internals (title/description go through the SEO pass)
	"rp4wp_", // Related Posts for WP
	"saswp_", // Schema & Structured Data for WP
	"sbg_", // Simple Blog Grid
	"snap_", // SNAP auto-poster
	"spay_", // Simple Pay
	"tie_", // TieLabs themes
	"wl_", // WordLift
	"wpil_", // Link Whisper
	"wprm_", // WP Recipe Maker internals
	"wpswa_", // WP Search with Algolia
	"wpuf_", // WP User Frontend
	"yarpp_", // YARPP
];

/** Exact meta keys that are plugin/core bookkeeping, not content. */
const PLUGIN_META_KEYS = new Set([
	"entity_same_as", // WordLift
	"exclude_from_search", // search exclusion plugins
	"footnotes", // Gutenberg core footnotes store
	"inline_featured_image", // inline featured image plugin
	"os_meta", // theme option stores
	"thirstydata", // ThirstyAffiliates
]);

/**
 * Check whether a meta key is well-known plugin bookkeeping that should
 * not become a content field. Hyphens are normalized to underscores
 * before matching (e.g. `ampforwp-amp-on-off`).
 */
export function isPluginBookkeepingMeta(key: string): boolean {
	const normalized = key.replaceAll("-", "_");
	if (PLUGIN_META_KEYS.has(normalized)) return true;
	return PLUGIN_META_PREFIXES.some((prefix) => normalized.startsWith(prefix));
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
// Internal Link Relativization
// =============================================================================

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
const LEADING_WWW = /^www\./;

/**
 * Turn an absolute URL into a root-relative one when it points at the
 * source site (www-insensitive). Returns null when the URL should be
 * left alone: external links, non-http(s) schemes, and `/wp-content/`
 * media files — those stay absolute so the later media pass can match
 * them against its old-URL -> new-URL map.
 */
function relativizeUrl(url: string, sourceHost: string): string | null {
	if (!url.startsWith("http://") && !url.startsWith("https://")) return null;
	try {
		const parsed = new URL(url);
		if (parsed.hostname.replace(LEADING_WWW, "") !== sourceHost) return null;
		if (parsed.pathname.startsWith("/wp-content/")) return null;
		return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
	} catch {
		return null;
	}
}

function relativizeMarkDefs(
	markDefs: Array<{ _type: string; [key: string]: unknown }> | undefined,
	sourceHost: string,
): void {
	for (const def of markDefs ?? []) {
		if (def._type === "link" && typeof def.href === "string") {
			def.href = relativizeUrl(def.href, sourceHost) ?? def.href;
		}
	}
}

/**
 * Rewrite internal links in imported content to root-relative URLs, in
 * place. Without this, imported posts keep linking back to the old
 * WordPress domain (e.g. `https://oldsite.com/companies/google/`)
 * instead of staying on the new site.
 *
 * ponytail: path structures are kept as-is (WP permalink /2024/05/slug/
 * stays /2024/05/slug/) — mapping old paths onto the new site's routes
 * is the planned permalink->redirect-map feature.
 */
export function relativizeContentLinks(blocks: PortableTextBlock[], siteUrl: string): void {
	let sourceHost: string;
	try {
		sourceHost = new URL(siteUrl).hostname.replace(LEADING_WWW, "");
	} catch {
		return;
	}
	// Raw HTML in the wild uses double-quoted, single-quoted, and unquoted
	// href values; the backreference \1 matches the closing quote (or
	// nothing, for unquoted). Rewritten links are normalized to href="...".
	const hrefPattern = new RegExp(
		`href=(["']?)https?://(?:www\\.)?${sourceHost.replace(REGEX_SPECIALS, "\\$&")}(/[^"'\\s>]*)?\\1`,
		"gi",
	);

	for (const block of blocks) {
		switch (block._type) {
			case "block":
				relativizeMarkDefs(block.markDefs, sourceHost);
				break;
			case "image":
				// asset.url stays absolute (media pass), only the click-through link
				if (block.link) block.link = relativizeUrl(block.link, sourceHost) ?? block.link;
				break;
			case "table":
				for (const row of block.rows) {
					for (const cell of row.cells) relativizeMarkDefs(cell.markDefs, sourceHost);
				}
				break;
			case "columns":
				for (const column of block.columns) relativizeContentLinks(column.content, siteUrl);
				break;
			case "cover":
				relativizeContentLinks(block.content, siteUrl);
				break;
			case "button":
				if (block.url) block.url = relativizeUrl(block.url, sourceHost) ?? block.url;
				break;
			case "buttons":
				for (const button of block.buttons) {
					if (button.url) button.url = relativizeUrl(button.url, sourceHost) ?? button.url;
				}
				break;
			case "htmlBlock":
				block.html = block.html.replace(
					hrefPattern,
					(_m, _quote: string, path: string | undefined) => {
						return `href="${path || "/"}"`;
					},
				);
				break;
			// URL-less or media-only blocks: media URLs are the media pass's job
			case "code":
			case "embed":
			case "gallery":
			case "break":
			case "file":
			case "pullquote":
				break;
			default:
				block satisfies never;
		}
	}
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
