/**
 * Shared locale-resolution helpers.
 *
 * Matches the pattern used by `query.ts` for content: an explicit locale wins,
 * otherwise we fall back to the request-context locale, otherwise to
 * `defaultLocale` when i18n is enabled, otherwise to `undefined` (meaning "do
 * not filter by locale" — legacy single-locale behaviour).
 */

import { getRequestContext } from "../request-context.js";
import { getFallbackChain, getI18nConfig, isI18nEnabled } from "./config.js";

/**
 * Resolve the locale to use for a query given an optional explicit value.
 * Returns `undefined` when no locale information is available; callers should
 * treat that as "do not filter by locale".
 */
export function resolveLocale(explicit?: string): string | undefined {
	if (explicit !== undefined) return explicit;
	const ctxLocale = getRequestContext()?.locale;
	if (ctxLocale !== undefined) return ctxLocale;
	const cfg = getI18nConfig();
	if (cfg && isI18nEnabled()) return cfg.defaultLocale;
	return undefined;
}

/**
 * Fallback chain to try when looking up a single item. When i18n is disabled
 * or the locale is unspecified, returns a single-element array (or empty when
 * no locale resolves) so callers can iterate uniformly.
 */
export function resolveLocaleChain(explicit?: string): string[] {
	const locale = resolveLocale(explicit);
	if (locale === undefined) return [];
	if (!isI18nEnabled()) return [locale];
	return getFallbackChain(locale);
}

const REPEATED_SLASHES = /\/{2,}/g;

/**
 * Interpolate a collection `url_pattern` with a row's slug and id.
 *
 * Falls back to `/{collection}/{slug}` when no pattern is configured.
 * Does NOT apply any locale prefix — pass the result through
 * Astro's `getRelativeLocaleUrl` / `getAbsoluteLocaleUrl` (or the
 * `localizePath` helper below) to add the locale segment.
 */
export function interpolateUrlPattern(options: {
	pattern: string | null;
	collection: string;
	slug: string;
	id: string;
}): string {
	const { pattern, collection, slug, id } = options;
	const basePattern = pattern ?? `/${encodeURIComponent(collection)}/{slug}`;
	let path = basePattern
		.replace("{slug}", encodeURIComponent(slug))
		.replace("{id}", encodeURIComponent(id));
	path = path.replace(REPEATED_SLASHES, "/");
	if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
	if (!path.startsWith("/")) path = `/${path}`;
	return path;
}

/**
 * Apply a locale prefix to a path, honouring the user's Astro `i18n`
 * routing config (`prefixDefaultLocale`, custom `path`/`codes` mappings).
 *
 * Reads the resolved config from `astro:config/server`, which is always
 * available regardless of whether i18n is enabled -- so this function
 * works in both i18n and non-i18n builds without tripping Astro's
 * `i18nNotEnabled` resolver (the case with importing `astro:i18n`).
 *
 * Returns:
 *   - The original `path` when i18n is not configured.
 *   - The original `path` for the default locale when
 *     `prefixDefaultLocale` is false.
 *   - `/{segment}{path}` for any other configured locale, where
 *     `{segment}` is the locale's custom `path` if one is set,
 *     otherwise the locale code.
 *   - `null` when the row's locale isn't in the configured list.
 *     Callers should drop the entry: a sitemap link to a route the
 *     site can't serve is worse than no link at all (search engines
 *     get a 404 / soft-404 and downrank the page).
 *
 * Falls back to `getI18nConfig()` (EmDash's mirror of the same config,
 * populated at runtime startup) when `astro:config/server` is
 * unavailable -- e.g. running outside an Astro build context, such as
 * in vitest.
 */
export async function localizePath(path: string, locale: string): Promise<string | null> {
	const segment = await resolveLocaleSegment(locale);
	if (segment === undefined) return null;
	if (segment === null || segment === "") return normalizePath(path);
	return normalizePath(`/${segment}${path}`);
}

/**
 * Resolve the URL segment to use for a locale.
 *
 * Returns:
 *   - `null` when i18n isn't configured (caller should not prefix).
 *   - `""` when the locale is the default locale and
 *     `prefixDefaultLocale` is false (caller should not prefix).
 *   - The locale's custom `path` value, or the locale string itself.
 *   - `undefined` when the locale isn't in the configured list --
 *     the row points at a route the site can't serve.
 */
async function resolveLocaleSegment(locale: string): Promise<string | null | undefined> {
	const i18n = await readAstroI18nConfig();
	if (!i18n || !i18n.locales || i18n.locales.length <= 1) return null;

	const isDefault = locale === i18n.defaultLocale;
	if (isDefault && !i18n.prefixDefaultLocale) return "";

	// When the locale has a custom `path`/`codes` mapping, use the path
	// for the URL segment. Otherwise use the locale code directly.
	for (const entry of i18n.locales) {
		if (typeof entry === "string") {
			if (entry === locale) return entry;
		} else if (entry.codes.includes(locale)) {
			return entry.path;
		}
	}

	return undefined;
}

interface AstroI18nConfig {
	defaultLocale: string;
	locales: Array<string | { codes: readonly string[]; path: string }>;
	prefixDefaultLocale?: boolean;
}

let astroI18nCache: AstroI18nConfig | null | undefined;

async function readAstroI18nConfig(): Promise<AstroI18nConfig | null> {
	if (astroI18nCache !== undefined) return astroI18nCache;

	try {
		const mod = (await import("astro:config/server")) as {
			i18n?: {
				defaultLocale: string;
				locales: Array<string | { codes: readonly string[]; path: string }>;
				routing?: { prefixDefaultLocale?: boolean } | string;
			};
		};
		if (!mod.i18n) {
			astroI18nCache = null;
			return null;
		}
		const routing = mod.i18n.routing;
		astroI18nCache = {
			defaultLocale: mod.i18n.defaultLocale,
			locales: mod.i18n.locales,
			prefixDefaultLocale:
				typeof routing === "object" ? (routing.prefixDefaultLocale ?? false) : false,
		};
		return astroI18nCache;
	} catch {
		// `astro:config/server` isn't resolvable (e.g. running under vitest
		// outside an Astro build). Fall back to EmDash's runtime config,
		// which is populated at startup via the same astroConfig object.
		const cfg = getI18nConfig();
		if (!cfg || !isI18nEnabled()) {
			astroI18nCache = null;
			return null;
		}
		astroI18nCache = {
			defaultLocale: cfg.defaultLocale,
			locales: cfg.locales,
			prefixDefaultLocale: cfg.prefixDefaultLocale,
		};
		return astroI18nCache;
	}
}

/** @internal -- exposed for tests to reset the module-level cache. */
export function _resetAstroI18nCacheForTests(): void {
	astroI18nCache = undefined;
}

function normalizePath(path: string): string {
	let p = path.replace(REPEATED_SLASHES, "/");
	if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
	if (!p.startsWith("/")) p = `/${p}`;
	return p;
}
