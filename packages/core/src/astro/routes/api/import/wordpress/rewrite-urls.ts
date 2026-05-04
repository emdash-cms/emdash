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
import { validateIdentifier } from "#db/validate.js";
import { normalizeMediaValue } from "#media/normalize.js";
import type { MediaProvider } from "#media/types.js";
import type { EmDashHandlers } from "#types";

import {
	buildBaseUrlMap,
	findMatchingUrl,
	rewritePortableTextUrls,
	rewriteStringUrls,
} from "./rewrite-url-helpers.js";

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

export const prerender = false;

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
		validateIdentifier(collection.slug, "collection slug");
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
						// Build update query dynamically
						// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Kysely dynamic table requires type assertion
						let query = db.updateTable(tableName as any).where("id", "=", row.id);

						for (const [key, value] of Object.entries(updates)) {
							// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Kysely dynamic column update requires type assertion
							query = query.set({ [key]: value } as any);
						}

						await query.execute();

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
