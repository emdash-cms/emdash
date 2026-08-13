/**
 * hreflang alternate resolution for translated content (#1690).
 *
 * Mirrors the sitemap route's semantics so the render path and the
 * sitemap always agree:
 *
 * - Alternates are emitted per published locale variant of a
 *   translation group, including a self-referencing entry (Google
 *   recommends the page annotate itself).
 * - `x-default` points at the default-locale variant, falling back to
 *   the first routable variant when the default locale has no
 *   translation.
 * - Variants whose locale isn't in the configured `i18n.locales` list
 *   are dropped: linking to a route the site can't serve is worse than
 *   no link at all.
 * - Variants flagged `noindex` in the SEO panel are excluded — the
 *   sitemap doesn't list them, and pointing search engines at a page
 *   that asks not to be indexed is a contradictory signal. When the
 *   entry itself is noindex the result is empty: a page opting out of
 *   indexing shouldn't announce an hreflang set at all.
 * - When i18n is disabled (or no absolute site URL can be resolved,
 *   which hreflang requires) the result is empty and no queries run.
 */

import type { Kysely } from "kysely";

import { ContentRepository } from "../database/repositories/content.js";
import type { Database } from "../database/types.js";
import { getI18nConfig, isI18nEnabled } from "../i18n/config.js";
import { interpolateUrlPattern, localizePath } from "../i18n/resolve.js";
import { requestCached } from "../request-cache.js";
import { getCollectionInfoWithDb } from "../schema/query.js";
import { getSiteSettingsWithDb } from "../settings/index.js";

const TRAILING_SLASH_RE = /\/$/;
const ABSOLUTE_URL_RE = /^https?:\/\//i;

/**
 * IDs of variants flagged `noindex` in the SEO panel. Entries without
 * an `_emdash_seo` row are indexable by default (same as the sitemap).
 * The id list is bounded by the number of configured locales, so no
 * chunking is needed.
 */
async function findNoindexIds(
	db: Kysely<Database>,
	collection: string,
	ids: string[],
): Promise<Set<string>> {
	if (ids.length === 0) return new Set();
	const rows = await db
		.selectFrom("_emdash_seo")
		.select("content_id")
		.where("collection", "=", collection)
		.where("content_id", "in", ids)
		.where("seo_no_index", "=", 1)
		.execute();
	return new Set(rows.map((r) => r.content_id));
}

/** A single alternate link, ready to render as `<link rel="alternate">`. */
export interface HreflangAlternate {
	/** Locale code, or `"x-default"` for the default variant */
	hreflang: string;
	/** Absolute URL of the variant */
	href: string;
}

export interface HreflangOptions {
	/**
	 * Absolute site origin (e.g. `https://example.com`) used to build
	 * the alternate URLs. Falls back to the site settings URL; when
	 * neither is available the result is empty, since hreflang
	 * requires fully-qualified URLs.
	 */
	siteUrl?: string;
}

/**
 * Resolve hreflang alternates for a content entry.
 *
 * @example
 * ```astro
 * ---
 * import { getHreflangAlternates } from "emdash";
 *
 * const alternates = await getHreflangAlternates("posts", entry.data.id, {
 *   siteUrl: Astro.url.origin,
 * });
 * ---
 * <head>
 *   {alternates.map((a) => <link rel="alternate" hreflang={a.hreflang} href={a.href} />)}
 * </head>
 * ```
 */
export async function getHreflangAlternates(
	collection: string,
	entryId: string,
	options: HreflangOptions = {},
): Promise<HreflangAlternate[]> {
	if (!isI18nEnabled()) return [];
	const key = `hreflang:${collection}:${entryId}:${options.siteUrl ?? ""}`;
	return requestCached(key, async () => {
		const { getDb } = await import("../loader.js");
		const db = await getDb();
		return getHreflangAlternatesWithDb(db, collection, entryId, options);
	});
}

/**
 * Resolve hreflang alternates with an explicit db handle.
 *
 * @internal Use `getHreflangAlternates()` in templates. This variant is
 * for routes/components that already have a database handle.
 */
export async function getHreflangAlternatesWithDb(
	db: Kysely<Database>,
	collection: string,
	entryId: string,
	options: HreflangOptions = {},
): Promise<HreflangAlternate[]> {
	if (!isI18nEnabled()) return [];

	let siteUrl = options.siteUrl;
	if (!siteUrl) {
		const settings = await getSiteSettingsWithDb(db);
		siteUrl = settings.url;
	}
	// hreflang requires fully-qualified URLs; a relative site URL would
	// produce invalid output (and EmDashHead's isSafeHref would drop it).
	if (!siteUrl || !ABSOLUTE_URL_RE.test(siteUrl)) return [];
	siteUrl = siteUrl.replace(TRAILING_SLASH_RE, "");

	const repo = new ContentRepository(db);
	const item = await repo.findByIdOrSlug(collection, entryId);
	if (!item) return [];

	// Legacy rows imported before i18n may have no translation_group;
	// treat them as a single-variant group.
	const group = item.translationGroup || item.id;
	let variants = await repo.findTranslations(collection, group);
	if (variants.length === 0) variants = [item];

	let published = variants.filter((v) => v.status === "published");
	if (published.length === 0) return [];

	// Exclude noindex variants, matching the sitemap's `_emdash_seo`
	// filter so head and sitemap agree on which variants are
	// discoverable. When the requested entry itself is noindex, emit
	// nothing: a page opting out of indexing shouldn't announce an
	// hreflang set.
	const noindexIds = await findNoindexIds(
		db,
		collection,
		published.map((v) => v.id),
	);
	if (noindexIds.has(item.id)) return [];
	published = published.filter((v) => !noindexIds.has(v.id));

	const info = await getCollectionInfoWithDb(db, collection);
	const urlPattern = info?.urlPattern ?? null;

	const resolved: Array<{ locale: string; href: string }> = [];
	for (const variant of published) {
		const locale = variant.locale || "en";
		const path = interpolateUrlPattern({
			pattern: urlPattern,
			collection,
			slug: variant.slug || variant.id,
			id: variant.id,
		});
		const localized = await localizePath(path, locale);
		if (localized === null) continue;
		resolved.push({ locale, href: `${siteUrl}${localized}` });
	}
	if (resolved.length === 0) return [];

	resolved.sort((a, b) => a.locale.localeCompare(b.locale));
	const alternates: HreflangAlternate[] = resolved.map((r) => ({
		hreflang: r.locale,
		href: r.href,
	}));

	// x-default: default-locale variant, else the first routable one.
	// Same fallback the sitemap route uses.
	const defaultLocale = getI18nConfig()?.defaultLocale;
	const xDefault = resolved.find((r) => r.locale === defaultLocale) ?? resolved[0];
	if (xDefault) {
		alternates.push({ hreflang: "x-default", href: xDefault.href });
	}

	return alternates;
}
