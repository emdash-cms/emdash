/**
 * WordPress URL rewrite endpoint
 *
 * POST /_emdash/api/import/wordpress/rewrite-urls
 *
 * Rewrites old WordPress media URLs in Portable Text content
 * to point to newly imported EmDash media URLs.
 *
 * Handles URL variants (e.g., image.jpg vs image.jpg?w=200) by matching
 * on the base URL path without query parameters.
 */

import type { APIRoute } from "astro";
import { sql } from "kysely";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { wpRewriteUrlsBody } from "#api/schemas.js";
import { normalizeMediaValue } from "#media/normalize.js";
import type { MediaProvider } from "#media/types.js";
import type { EmDashHandlers } from "#types";

export const prerender = false;

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

export interface RewriteUrlsResult {
	/** Total items updated */
	updated: number;
	/** Updates by collection */
	byCollection: Record<string, number>;
	/** URLs that were rewritten */
	urlsRewritten: number;
	/** Any errors encountered */
	errors: Array<{ collection: string; id: string; error: string }>;
}

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NO_DB", "Database not initialized", 500);
	}

	const denied = requirePerm(user, "import:execute");
	if (denied) return denied;

	try {
		const body = await parseBody(request, wpRewriteUrlsBody);
		if (isParseError(body)) return body;

		const urlEntries = Object.entries(body.urlMap);
		if (urlEntries.length === 0) {
			return apiSuccess({
				updated: 0,
				byCollection: {},
				urlsRewritten: 0,
				errors: [],
			});
		}

		const getProvider = (id: string) => emdash.getMediaProvider(id);
		const result = await rewriteUrls(emdash.db, body.urlMap, getProvider, body.collections);

		return apiSuccess(result);
	} catch (error) {
		return handleError(error, "Failed to rewrite URLs", "REWRITE_ERROR");
	}
};

/**
 * Strip query parameters from a URL for base matching
 */
function getBaseUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		// If URL parsing fails, try simple string split
		return url.split("?")[0] || url;
	}
}

/**
 * Build a map of base URLs to new URLs for flexible matching
 */
function buildBaseUrlMap(urlMap: Record<string, string>): Map<string, string> {
	const baseMap = new Map<string, string>();
	for (const [oldUrl, newUrl] of Object.entries(urlMap)) {
		const baseUrl = getBaseUrl(oldUrl);
		baseMap.set(baseUrl, newUrl);
	}
	return baseMap;
}

/**
 * Find matching new URL for a given URL, checking both exact and base matches
 */
function findMatchingUrl(
	url: string,
	exactMap: Record<string, string>,
	baseMap: Map<string, string>,
): string | null {
	// Try exact match first
	if (exactMap[url]) {
		return exactMap[url];
	}

	// Try base URL match (ignoring query params)
	const baseUrl = getBaseUrl(url);
	const baseMatch = baseMap.get(baseUrl);
	if (baseMatch) {
		return baseMatch;
	}

	return null;
}

/**
 * Portable Text block type (simplified for URL rewriting)
 */
interface PortableTextBlock {
	_type: string;
	_key?: string;
	asset?: {
		_type?: string;
		_ref?: string;
		url?: string;
	};
	link?: string;
	// For nested content like galleries
	images?: PortableTextBlock[];
	columns?: Array<{ content?: PortableTextBlock[] }>;
	[key: string]: unknown;
}

/**
 * Rewrite URLs in a Portable Text array, returning whether any changes were made
 */
function rewritePortableTextUrls(
	blocks: PortableTextBlock[],
	exactMap: Record<string, string>,
	baseMap: Map<string, string>,
): { changed: boolean; urlsRewritten: number } {
	let changed = false;
	let urlsRewritten = 0;

	for (const block of blocks) {
		// Handle image blocks
		if (block._type === "image" && block.asset?.url) {
			const newUrl = findMatchingUrl(block.asset.url, exactMap, baseMap);
			if (newUrl) {
				block.asset.url = newUrl;
				block.asset._ref = newUrl; // Also update the reference
				changed = true;
				urlsRewritten++;
			}
		}

		// Handle image link URLs (for linked images)
		if (block._type === "image" && block.link) {
			const newUrl = findMatchingUrl(block.link, exactMap, baseMap);
			if (newUrl) {
				block.link = newUrl;
				changed = true;
				urlsRewritten++;
			}
		}

		// Handle gallery blocks with nested images
		if (block._type === "gallery" && Array.isArray(block.images)) {
			const result = rewritePortableTextUrls(block.images, exactMap, baseMap);
			if (result.changed) {
				changed = true;
				urlsRewritten += result.urlsRewritten;
			}
		}

		// Handle columns blocks with nested content
		if (block._type === "columns" && Array.isArray(block.columns)) {
			for (const column of block.columns) {
				if (Array.isArray(column.content)) {
					const result = rewritePortableTextUrls(column.content, exactMap, baseMap);
					if (result.changed) {
						changed = true;
						urlsRewritten += result.urlsRewritten;
					}
				}
			}
		}
	}

	return { changed, urlsRewritten };
}

/**
 * Rewrite URLs in a string field using simple string replacement
 */
function rewriteStringUrls(
	value: string,
	exactMap: Record<string, string>,
	baseMap: Map<string, string>,
): { newValue: string; changed: boolean; urlsRewritten: number } {
	let newValue = value;
	let changed = false;
	let urlsRewritten = 0;

	// Try exact matches first
	for (const [oldUrl, newUrl] of Object.entries(exactMap)) {
		if (newValue.includes(oldUrl)) {
			newValue = newValue.split(oldUrl).join(newUrl);
			changed = true;
			urlsRewritten++;
		}
	}

	// For base URL matching in strings, we need to be more careful
	// Only match if we find a URL that starts with the base
	for (const [baseUrl, newUrl] of baseMap.entries()) {
		// Look for the base URL followed by optional query string or end
		const regex = new RegExp(escapeRegExp(baseUrl) + "(\\?[^\"'\\s]*)?", "g");
		const matches = newValue.match(regex);
		if (matches) {
			for (const match of matches) {
				// Don't replace if we already have an exact match in the map
				if (!exactMap[match]) {
					newValue = newValue.split(match).join(newUrl);
					changed = true;
					urlsRewritten++;
				}
			}
		}
	}

	return { newValue, changed, urlsRewritten };
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(string: string): string {
	return string.replace(REGEX_SPECIAL_CHARS, "\\$&");
}

async function rewriteUrls(
	db: NonNullable<EmDashHandlers["db"]>,
	urlMap: Record<string, string>,
	getProvider: (id: string) => MediaProvider | undefined,
	collections?: string[],
): Promise<RewriteUrlsResult> {
	const { SchemaRegistry } = await import("#schema/registry.js");
	const registry = new SchemaRegistry(db);

	const result: RewriteUrlsResult = {
		updated: 0,
		byCollection: {},
		urlsRewritten: 0,
		errors: [],
	};

	// Build base URL map for flexible matching
	const baseMap = buildBaseUrlMap(urlMap);

	// Get all collections or filter to specified ones
	const allCollections = await registry.listCollections();
	const targetCollections = collections?.length
		? allCollections.filter((c) => collections.includes(c.slug))
		: allCollections;

	for (const collection of targetCollections) {
		// Get fields that might contain URLs
		const fields = await registry.listFields(collection.id);
		const portableTextFields = fields.filter((f) => f.type === "portableText");
		const stringFields = fields.filter((f) => ["text", "string"].includes(f.type));
		// Image and file fields store URLs directly as TEXT
		const mediaFields = fields.filter((f) => ["image", "file"].includes(f.type));

		if (portableTextFields.length === 0 && stringFields.length === 0 && mediaFields.length === 0)
			continue;

		// Get table name
		const tableName = `ec_${collection.slug}`;

		try {
			// Query all rows
			const rows = await sql<{ id: string; [key: string]: unknown }>`
				SELECT * FROM ${sql.ref(tableName)}
				WHERE deleted_at IS NULL
			`.execute(db);

			for (const row of rows.rows) {
				let rowUpdated = false;
				const updates: Record<string, unknown> = {};
				let rowUrlsRewritten = 0;

				// Handle Portable Text fields - parse JSON and rewrite URLs in blocks
				for (const field of portableTextFields) {
					const value = row[field.slug];
					if (!value || typeof value !== "string") continue;

					try {
						// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- JSON.parse returns unknown; validated by Array.isArray below
						const blocks = JSON.parse(value) as PortableTextBlock[];
						if (!Array.isArray(blocks)) continue;

						const rewriteResult = rewritePortableTextUrls(blocks, urlMap, baseMap);

						if (rewriteResult.changed) {
							updates[field.slug] = JSON.stringify(blocks);
							rowUpdated = true;
							rowUrlsRewritten += rewriteResult.urlsRewritten;
						}
					} catch {
						// Not valid JSON, try string replacement as fallback
						const stringResult = rewriteStringUrls(value, urlMap, baseMap);
						if (stringResult.changed) {
							updates[field.slug] = stringResult.newValue;
							rowUpdated = true;
							rowUrlsRewritten += stringResult.urlsRewritten;
						}
					}
				}

				// Handle string/text fields - simple string replacement
				for (const field of stringFields) {
					const value = row[field.slug];
					if (!value || typeof value !== "string") continue;

					const stringResult = rewriteStringUrls(value, urlMap, baseMap);
					if (stringResult.changed) {
						updates[field.slug] = stringResult.newValue;
						rowUpdated = true;
						rowUrlsRewritten += stringResult.urlsRewritten;
					}
				}

				// Handle image/file fields - normalize to MediaValue objects
				for (const field of mediaFields) {
					const value = row[field.slug];
					if (!value || typeof value !== "string") continue;

					// Try to find a matching rewritten URL
					const newUrl = findMatchingUrl(value, urlMap, baseMap);
					if (newUrl) {
						// Normalize into a proper MediaValue instead of storing a bare URL
						try {
							const normalized = await normalizeMediaValue(newUrl, getProvider);
							updates[field.slug] = normalized ? JSON.stringify(normalized) : newUrl;
						} catch {
							updates[field.slug] = newUrl;
						}
						rowUpdated = true;
						rowUrlsRewritten++;
					}
				}

				if (rowUpdated) {
					try {
						const setClauses = Object.entries(updates).map(
							([key, value]) => sql`${sql.ref(key)} = ${value}`,
						);

						if (setClauses.length > 0) {
							await sql`
								UPDATE ${sql.ref(tableName)}
								SET ${sql.join(setClauses, sql`, `)}
								WHERE id = ${row.id}
							`.execute(db);
						}

						result.updated++;
						result.urlsRewritten += rowUrlsRewritten;
						result.byCollection[collection.slug] = (result.byCollection[collection.slug] || 0) + 1;
					} catch (updateError) {
						result.errors.push({
							collection: collection.slug,
							id: row.id,
							error: updateError instanceof Error ? updateError.message : "Update failed",
						});
					}
				}
			}
		} catch (queryError) {
			result.errors.push({
				collection: collection.slug,
				id: "*",
				error: queryError instanceof Error ? queryError.message : "Query failed for collection",
			});
		}
	}

	return result;
}
