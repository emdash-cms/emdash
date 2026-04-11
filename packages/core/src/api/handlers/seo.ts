/**
 * SEO Handlers
 *
 * Business logic for sitemap generation and robots.txt.
 */

import { sql, type Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import type { ApiResult } from "../types.js";

/** Raw content data for sitemap generation — the route builds the actual URLs */
export interface SitemapContentEntry {
	/** Content ID (ULID) */
	id: string;
	/** Content slug, or null when the entry has no slug */
	slug: string | null;
	/** ISO date of last modification */
	updatedAt: string;
}

/** Per-collection sitemap data with entries and URL pattern */
export interface SitemapCollectionData {
	/** Collection slug (e.g., "post", "page") */
	collection: string;
	/** URL pattern with {slug} placeholder, or null for default /{collection}/{slug} */
	urlPattern: string | null;
	/** Most recent updated_at across all entries (for sitemap index lastmod) */
	lastmod: string;
	/** Individual content entries */
	entries: SitemapContentEntry[];
}

export interface SitemapDataResponse {
	collections: SitemapCollectionData[];
}

/** Maximum entries per sitemap (per spec) */
const SITEMAP_MAX_ENTRIES = 50_000;

/**
 * Collect all published, indexable content across SEO-enabled collections
 * for sitemap generation, grouped by collection.
 *
 * Only includes content from collections with `has_seo = 1`.
 * Excludes content with `seo_no_index = 1` in the `_emdash_seo` table.
 *
 * Returns raw data grouped per collection. The caller (route) is
 * responsible for building absolute URLs — this handler does NOT
 * assume a URL structure.
 */
export async function handleSitemapData(
	db: Kysely<Database>,
	/** When set, only return data for this collection. */
	collectionSlug?: string,
): Promise<ApiResult<SitemapDataResponse>> {
	try {
		// Find SEO-enabled collections (optionally filtered)
		let query = db
			.selectFrom("_emdash_collections")
			.select(["slug", "url_pattern"])
			.where("has_seo", "=", 1);

		if (collectionSlug) {
			query = query.where("slug", "=", collectionSlug);
		}

		const collections = await query.execute();

		const result: SitemapCollectionData[] = [];

		for (const col of collections) {
			// Validate the slug before using it as a table name identifier.
			// Should always pass (slugs are validated on creation), but
			// guards against corrupted DB data.
			try {
				validateIdentifier(col.slug, "collection slug");
			} catch {
				console.warn(`[SITEMAP] Skipping collection with invalid slug: ${col.slug}`);
				continue;
			}

			const tableName = `ec_${col.slug}`;

			// Query published, non-deleted content.
			// LEFT JOIN _emdash_seo to check noindex flag.
			// Content without an SEO row is assumed indexable (default).
			// Wrapped in try/catch so a missing/broken table doesn't fail the
			// entire sitemap — we skip that collection and continue.
			try {
				const rows = await sql<{
					slug: string | null;
					id: string;
					updated_at: string;
				}>`
					SELECT c.slug, c.id, c.updated_at
					FROM ${sql.ref(tableName)} c
					LEFT JOIN _emdash_seo s
						ON s.collection = ${col.slug}
						AND s.content_id = c.id
					WHERE c.status = 'published'
					AND c.deleted_at IS NULL
					AND (s.seo_no_index IS NULL OR s.seo_no_index = 0)
					ORDER BY c.updated_at DESC
					LIMIT ${SITEMAP_MAX_ENTRIES}
				`.execute(db);

				if (rows.rows.length === 0) continue;

				const entries: SitemapContentEntry[] = [];
				for (const row of rows.rows) {
					entries.push({
						id: row.id,
						slug: row.slug,
						updatedAt: row.updated_at,
					});
				}

				result.push({
					collection: col.slug,
					urlPattern: col.url_pattern,
					// Rows are ordered by updated_at DESC, so first row is the latest
					lastmod: rows.rows[0].updated_at,
					entries,
				});
			} catch (err) {
				// Table missing or query error — skip this collection
				console.warn(`[SITEMAP] Failed to query collection "${col.slug}":`, err);
				continue;
			}
		}

		return { success: true, data: { collections: result } };
	} catch (error) {
		console.error("[SITEMAP_ERROR]", error);
		return {
			success: false,
			error: { code: "SITEMAP_ERROR", message: "Failed to generate sitemap data" },
		};
	}
}
