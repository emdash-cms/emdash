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
import { resolveBylineCredits, type BylineEntry } from "./credits.js";

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

export type { BylineEntry } from "./credits.js";

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
	if (entries.length === 0) return new Map();
	return resolveBylineCredits(await getDb(), collection, entries);
}

/**
 * Get content entries credited to a byline, in any credit position.
 *
 * Unlike filtering on the content table's `primary_byline_id` column (which
 * only finds entries where the byline is the first/primary credit), this
 * matches every explicit credit recorded in `_emdash_content_bylines`, so
 * co-authored entries where the byline is a secondary credit are included.
 *
 * `byline` is matched against the byline's `translation_group` (the value
 * stored on credits since migration 040), so a single credit spans every
 * locale variant of the byline. Pass `byline.translationGroup ?? byline.id`
 * from `getByline` / `getBylineBySlug`. An array matches any of the given
 * bylines (OR).
 *
 * The result respects the active locale, status, ordering, and eager
 * hydration of `getEmDashCollection`.
 *
 * @example
 * ```ts
 * import { getBylineBySlug, getEntriesByByline } from "emdash";
 *
 * const byline = await getBylineBySlug("jane-doe");
 * if (byline) {
 *   const posts = await getEntriesByByline("posts", byline.translationGroup ?? byline.id, {
 *     orderBy: { published_at: "desc" },
 *   });
 * }
 * ```
 *
 * @param collection - The collection slug (e.g. "posts")
 * @param byline - A byline translation group, or an array of them (OR)
 * @param options - Optional locale, ordering, status, and limit
 */
export async function getEntriesByByline(
	collection: string,
	byline: string | string[],
	options: {
		locale?: string;
		orderBy?: Record<string, "asc" | "desc">;
		status?: "draft" | "published" | "archived";
		limit?: number;
	} = {},
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
	const { getEmDashCollection } = await import("../query.js");

	const queryOptions: Record<string, unknown> = {
		where: { byline },
	};
	if (options.locale !== undefined) queryOptions.locale = options.locale;
	if (options.orderBy !== undefined) queryOptions.orderBy = options.orderBy;
	if (options.status !== undefined) queryOptions.status = options.status;
	if (options.limit !== undefined) queryOptions.limit = options.limit;

	const { entries } = await getEmDashCollection(collection, queryOptions);
	return entries;
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
