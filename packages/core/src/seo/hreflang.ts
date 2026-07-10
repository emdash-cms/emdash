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
	if (!siteUrl) return [];
	siteUrl = siteUrl.replace(TRAILING_SLASH_RE, "");

	const repo = new ContentRepository(db);
	const item = await repo.findByIdOrSlug(collection, entryId);
	if (!item) return [];

	// Legacy rows imported before i18n may have no translation_group;
	// treat them as a single-variant group.
	const group = item.translationGroup || item.id;
	let variants = await repo.findTranslations(collection, group);
	if (variants.length === 0) variants = [item];

	const published = variants.filter((v) => v.status === "published");
	if (published.length === 0) return [];

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
