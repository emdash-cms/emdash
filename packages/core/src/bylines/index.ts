/**
 * Runtime API for bylines
 *
 * Provides functions to query byline profiles and byline credits
 * associated with content entries. Follows the same pattern as
 * the taxonomies runtime API.
 *
 * i18n model (migration 040): byline rows are per-locale and share a
 * `translation_group`. Credits on `_emdash_content_bylines.byline_id` store
 * the translation_group, so a single credit spans every locale of a byline.
 *
 * Hydration is strict per locale: a credit at locale X renders iff a byline
 * row exists at locale X within the credited translation_group. There is no
 * read-time fallback. Mirrors `getEntryTerms` and the convention in PR #916.
 * Locale is passed in by callers — `query.ts` resolves it from the entry's
 * own `data.locale` for the runtime path.
 */

import { sql } from "kysely";

import { BylineRepository } from "../database/repositories/byline.js";
import type { BylineSummary, ContentBylineCredit } from "../database/repositories/types.js";
import { validateIdentifier } from "../database/validate.js";
import { resolveLocaleChain } from "../i18n/resolve.js";
import { getDb } from "../loader.js";
import { requestCached } from "../request-cache.js";
import { isMissingTableError } from "../utils/db-errors.js";

/**
 * No-op — kept for API compatibility.
 *
 * Used to invalidate a worker-lifetime "has any byline?" probe. That
 * probe added a query on every cold isolate to save one query on sites
 * with zero bylines (i.e. the wrong tradeoff), so we dropped it. The
 * batch byline join below returns an empty map for empty sites at the
 * same cost as the probe, without the pre-check.
 */
export function invalidateBylineCache(): void {
	// Intentionally empty.
}

/**
 * Get a byline by ID.
 *
 * @example
 * ```ts
 * import { getByline } from "emdash";
 *
 * const byline = await getByline("01HXYZ...");
 * if (byline) {
 *   console.log(byline.displayName);
 * }
 * ```
 */
export async function getByline(id: string): Promise<BylineSummary | null> {
	const db = await getDb();
	const repo = new BylineRepository(db);
	return repo.findById(id);
}

/**
 * Get a byline by slug.
 *
 * Standalone identity lookup (e.g. rendering an author profile page). Walks
 * the configured locale fallback chain — same pattern as `getMenu` and
 * `getTerm`, see PR #916. Returns the first match found, walking
 * `[requestedLocale, ...fallbacks, defaultLocale]` in order.
 *
 * Note: this is intentionally different from credit hydration on a content
 * entry (`getEntryBylines`), which is strict per locale with no fallback.
 * The distinction: identity lookups answer "give me this byline", and
 * falling back to another locale's display name is acceptable. Credit
 * hydration answers "what should render on this entry", where falling back
 * silently surfaces a stale-locale name and contradicts editorial intent.
 *
 * @example
 * ```ts
 * import { getBylineBySlug } from "emdash";
 *
 * const byline = await getBylineBySlug("jane-doe", { locale: "de-de" });
 * if (byline) {
 *   console.log(byline.displayName);
 * }
 * ```
 */
export async function getBylineBySlug(
	slug: string,
	options?: { locale?: string },
): Promise<BylineSummary | null> {
	const chain = resolveLocaleChain(options?.locale);
	const cacheKey = `byline-by-slug:${slug}:${chain.length > 0 ? chain.join(",") : "*"}`;
	return requestCached(cacheKey, async () => {
		const db = await getDb();
		const repo = new BylineRepository(db);

		if (chain.length === 0) {
			// No i18n or no resolved locale — fall back to the repo's
			// "lowest-locale-code" deterministic match.
			return repo.findBySlug(slug);
		}

		for (const locale of chain) {
			const row = await repo.findBySlug(slug, { locale });
			if (row) return row;
		}
		return null;
	});
}

/**
 * Get byline credits for a single content entry.
 *
 * Strict per locale (post-migration 040): a credit renders iff a byline row
 * exists at the requested locale within the credited translation_group.
 * Callers wanting fallback behaviour apply it themselves. When `locale` is
 * omitted, returns every locale variant of every credit on the entry —
 * useful for admin tooling, not for end-user rendering.
 *
 * Internal: not re-exported from the `emdash` package entry point. Every
 * entry returned by `getEmDashCollection` / `getEmDashEntry` already has
 * `data.bylines` populated by `hydrateEntryBylines` (which uses the batch
 * helper `getBylinesForEntries` directly). Site code should read those
 * fields rather than calling this function.
 */
export async function getEntryBylines(
	collection: string,
	entryId: string,
	options?: { locale?: string },
): Promise<ContentBylineCredit[]> {
	validateIdentifier(collection, "collection");
	const db = await getDb();
	const repo = new BylineRepository(db);

	const localeOpt = options?.locale !== undefined ? { locale: options.locale } : undefined;
	const explicit = await repo.getContentBylines(collection, entryId, localeOpt);
	if (explicit.length > 0) {
		return explicit.map((c) => ({ ...c, source: "explicit" as const }));
	}

	// `primary_byline_id` is the explicit-credit sentinel: non-null
	// suppresses author fallback even when the credit doesn't resolve
	// at this locale.
	const ctx = await getEntryContext(db, collection, entryId);
	if (ctx.primaryBylineId) return [];

	if (ctx.authorId) {
		const fallback = await repo.findByUserId(ctx.authorId, localeOpt);
		if (fallback) {
			return [{ byline: fallback, sortOrder: 0, roleLabel: null, source: "inferred" }];
		}
	}

	return [];
}

/**
 * Entry reference for batch byline lookups. Passing `authorId`,
 * `primaryBylineId`, and `locale` in directly avoids a per-entry
 * `SELECT` against the content table during hydration.
 *
 * `primaryBylineId` is the explicit-credit sentinel — non-null suppresses
 * author fallback. `locale` drives the strict per-locale join.
 */
export interface BylineEntry {
	id: string;
	authorId: string | null;
	primaryBylineId?: string | null;
	locale?: string | null;
}

/**
 * Batch-fetch byline credits for multiple content entries.
 *
 * Per-entry strict-locale hydration: entries are bucketed by `entry.locale`
 * and each bucket gets a single batched call to the strict-locale repo
 * method. Items with no `locale` field (legacy / single-locale installs)
 * share an unscoped bucket.
 *
 * Internal: consumed by `hydrateEntryBylines` in `query.ts` so that every
 * entry returned from `getEmDashCollection` / `getEmDashEntry` already has
 * `data.bylines` populated. Site code should rely on that eager hydration
 * rather than calling this directly -- this function is not re-exported
 * from the `emdash` package entry point.
 *
 * @param collection - The collection slug (e.g., "posts")
 * @param entries - Entry id + authorId + locale (each entry resolves at its own locale)
 * @returns Map from entry ID to array of byline credits
 */
export async function getBylinesForEntries(
	collection: string,
	entries: BylineEntry[],
): Promise<Map<string, ContentBylineCredit[]>> {
	validateIdentifier(collection, "collection");
	const result = new Map<string, ContentBylineCredit[]>();

	for (const { id } of entries) {
		result.set(id, []);
	}

	if (entries.length === 0) {
		return result;
	}

	const db = await getDb();
	const repo = new BylineRepository(db);

	// Bucket entries by locale so each bucket fires a single strict-locale
	// `getContentBylinesMany` call. Items with no locale field share a
	// bucket keyed by null (no `WHERE locale = ?` applied — legacy
	// pre-i18n shape).
	const buckets = new Map<string | null, BylineEntry[]>();
	for (const entry of entries) {
		const key = entry.locale ?? null;
		const bucket = buckets.get(key);
		if (bucket) bucket.push(entry);
		else buckets.set(key, [entry]);
	}

	// Sites with no bylines get an empty map back at the same cost as the
	// previous "has any bylines" probe, without the extra round-trip.
	// Pre-migration databases (bylines table missing) fall through to the
	// `isMissingTableError` catch below and return empty.
	const explicitByEntry = new Map<string, ContentBylineCredit[]>();
	const entriesNeedingAuthorCheck: BylineEntry[] = [];
	for (const [locale, bucket] of buckets) {
		const localeOpt = locale ? { locale } : undefined;
		const bucketIds = bucket.map((e) => e.id);
		let bylinesMap;
		try {
			bylinesMap = await repo.getContentBylinesMany(collection, bucketIds, localeOpt);
		} catch (error) {
			if (isMissingTableError(error)) return result;
			throw error;
		}
		for (const [id, list] of bylinesMap) explicitByEntry.set(id, list);

		for (const entry of bucket) {
			const hasResolved = bylinesMap.has(entry.id) && bylinesMap.get(entry.id)!.length > 0;
			if (hasResolved) continue;
			if (entry.authorId) entriesNeedingAuthorCheck.push(entry);
		}
	}

	// Only entries without an explicit credit (primaryBylineId null) are
	// eligible for author fallback.
	const fallbackByEntry = new Map<string, BylineSummary>();
	if (entriesNeedingAuthorCheck.length > 0) {
		const authorBuckets = new Map<string | null, BylineEntry[]>();
		for (const entry of entriesNeedingAuthorCheck) {
			if (entry.primaryBylineId) continue;
			const key = entry.locale ?? null;
			const bucket = authorBuckets.get(key);
			if (bucket) bucket.push(entry);
			else authorBuckets.set(key, [entry]);
		}

		for (const [locale, bucket] of authorBuckets) {
			const localeOpt = locale ? { locale } : undefined;
			const authorIds = bucket.map((e) => e.authorId).filter((id): id is string => id !== null);
			const uniqueAuthorIds = [...new Set(authorIds)];
			if (uniqueAuthorIds.length === 0) continue;
			const authorBylineMap = await repo.findByUserIds(uniqueAuthorIds, localeOpt);
			for (const entry of bucket) {
				if (!entry.authorId) continue;
				const f = authorBylineMap.get(entry.authorId);
				if (f) fallbackByEntry.set(entry.id, f);
			}
		}
	}

	for (const { id } of entries) {
		const explicit = explicitByEntry.get(id);
		if (explicit && explicit.length > 0) {
			result.set(
				id,
				explicit.map((c) => ({ ...c, source: "explicit" as const })),
			);
			continue;
		}

		const fallback = fallbackByEntry.get(id);
		if (fallback) {
			result.set(id, [{ byline: fallback, sortOrder: 0, roleLabel: null, source: "inferred" }]);
		}
	}

	return result;
}

/** Reads `author_id` + `primary_byline_id` for one entry in a single query. */
async function getEntryContext(
	db: Awaited<ReturnType<typeof getDb>>,
	collection: string,
	entryId: string,
): Promise<{ authorId: string | null; primaryBylineId: string | null }> {
	validateIdentifier(collection, "collection");
	const tableName = `ec_${collection}`;

	const result = await sql<{
		author_id: string | null;
		primary_byline_id: string | null;
	}>`
		SELECT author_id, primary_byline_id FROM ${sql.ref(tableName)}
		WHERE id = ${entryId}
		LIMIT 1
	`.execute(db);

	const row = result.rows[0];
	return {
		authorId: row?.author_id ?? null,
		primaryBylineId: row?.primary_byline_id ?? null,
	};
}
