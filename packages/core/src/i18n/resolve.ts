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
