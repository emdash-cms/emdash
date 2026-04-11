import { sql, type Kysely } from "kysely";

import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import type { Database } from "../types.js";
import type { ContentSeo, ContentSeoInput } from "./types.js";

/** Default SEO values for content without an explicit SEO row */
const SEO_DEFAULTS: ContentSeo = {
	title: null,
	description: null,
	image: null,
	canonical: null,
	noIndex: false,
};

/**
 * Returns true if the input has at least one explicitly-set SEO field.
 * Used to skip no-op upserts when callers pass `{ seo: {} }`.
 */
function hasAnyField(input: ContentSeoInput): boolean {
	return (
		input.title !== undefined ||
		input.description !== undefined ||
		input.image !== undefined ||
		input.canonical !== undefined ||
		input.noIndex !== undefined
	);
}

/**
 * Repository for SEO metadata stored in `_emdash_seo`.
 *
 * SEO data lives in a separate table keyed by (collection, content_id).
 * Only collections with `has_seo = 1` should use this — callers are
 * responsible for checking the flag before reading/writing.
 */
export class SeoRepository {
	constructor(private db: Kysely<Database>) {}

	/**
	 * Get SEO data for a content item. Returns null defaults if no row exists.
	 */
	async get(collection: string, contentId: string): Promise<ContentSeo> {
		const row = await this.db
			.selectFrom("_emdash_seo")
			.selectAll()
			.where("collection", "=", collection)
			.where("content_id", "=", contentId)
			.executeTakeFirst();

		if (!row) {
			return { ...SEO_DEFAULTS };
		}

		return {
			title: row.seo_title ?? null,
			description: row.seo_description ?? null,
			image: row.seo_image ?? null,
			canonical: row.seo_canonical ?? null,
			noIndex: row.seo_no_index === 1,
		};
	}

	/**
	 * Get SEO data for multiple content items.
	 * Returns a Map keyed by content_id. Items without SEO rows get defaults.
	 *
	 * Chunks the `content_id IN (…)` clause so the total bound-parameter count
	 * per statement (ids + the `collection = ?` filter) stays within Cloudflare
	 * D1's 100-variable limit regardless of how many content items are passed.
	 */
	async getMany(collection: string, contentIds: string[]): Promise<Map<string, ContentSeo>> {
		const result = new Map<string, ContentSeo>();

		if (contentIds.length === 0) return result;

		// Pre-fill with defaults so every input id has an entry even if no row exists.
		for (const id of contentIds) {
			result.set(id, { ...SEO_DEFAULTS });
		}

		const uniqueContentIds = [...new Set(contentIds)];
		for (const chunk of chunks(uniqueContentIds, SQL_BATCH_SIZE)) {
			const rows = await this.db
				.selectFrom("_emdash_seo")
				.selectAll()
				.where("collection", "=", collection)
				.where("content_id", "in", chunk)
				.execute();

			for (const row of rows) {
				result.set(row.content_id, {
					title: row.seo_title ?? null,
					description: row.seo_description ?? null,
					image: row.seo_image ?? null,
					canonical: row.seo_canonical ?? null,
					noIndex: row.seo_no_index === 1,
				});
			}
		}

		return result;
	}

	/**
	 * Upsert SEO data for a content item using INSERT ON CONFLICT DO UPDATE
	 * for atomicity. Skips no-op writes when input has no fields set.
	 */
	async upsert(collection: string, contentId: string, input: ContentSeoInput): Promise<ContentSeo> {
		// Skip no-op: empty input (e.g., `{ seo: {} }` from form libs)
		if (!hasAnyField(input)) {
			return this.get(collection, contentId);
		}

		const now = new Date().toISOString();

		// Use INSERT ON CONFLICT for atomic upsert — avoids TOCTOU race
		// where two concurrent requests both see "no row" and both try INSERT.
		//
		// On conflict, we use COALESCE(excluded.col, current.col) so that
		// only explicitly-provided fields overwrite existing values.
		await sql`
			INSERT INTO _emdash_seo (
				collection, content_id,
				seo_title, seo_description, seo_image, seo_canonical, seo_no_index,
				created_at, updated_at
			) VALUES (
				${collection}, ${contentId},
				${input.title ?? null}, ${input.description ?? null},
				${input.image ?? null}, ${input.canonical ?? null},
				${input.noIndex ? 1 : 0},
				${now}, ${now}
			)
			ON CONFLICT (collection, content_id) DO UPDATE SET
				seo_title = ${input.title !== undefined ? sql`${input.title}` : sql`_emdash_seo.seo_title`},
				seo_description = ${input.description !== undefined ? sql`${input.description}` : sql`_emdash_seo.seo_description`},
				seo_image = ${input.image !== undefined ? sql`${input.image}` : sql`_emdash_seo.seo_image`},
				seo_canonical = ${input.canonical !== undefined ? sql`${input.canonical}` : sql`_emdash_seo.seo_canonical`},
				seo_no_index = ${input.noIndex !== undefined ? sql`${input.noIndex ? 1 : 0}` : sql`_emdash_seo.seo_no_index`},
				updated_at = ${now}
		`.execute(this.db);

		return this.get(collection, contentId);
	}

	/**
	 * Delete SEO data for a content item.
	 */
	async delete(collection: string, contentId: string): Promise<void> {
		await this.db
			.deleteFrom("_emdash_seo")
			.where("collection", "=", collection)
			.where("content_id", "=", contentId)
			.execute();
	}

	/**
	 * Copy SEO data from one content item to another.
	 * Used by duplicate. Clears canonical (it pointed to the original).
	 */
	async copyForDuplicate(collection: string, sourceId: string, targetId: string): Promise<void> {
		const source = await this.get(collection, sourceId);

		// Only write if there's actual SEO data worth copying
		if (
			source.title !== null ||
			source.description !== null ||
			source.image !== null ||
			source.noIndex
		) {
			await this.upsert(collection, targetId, {
				title: source.title,
				description: source.description,
				image: source.image,
				canonical: null, // Don't copy canonical — it pointed to the original
				noIndex: source.noIndex,
			});
		}
	}
}
