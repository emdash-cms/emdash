/**
 * Resolve the locale for outbound system emails (invite, magic link,
 * recovery). Only resolves the locale string: callers pass in the
 * `emdash:locale` option value (batched with their other options
 * reads) and use the returned locale to load localized copy from the
 * admin catalogs.
 *
 * Priority: the site-wide `emdash:locale` option (explicit site
 * language) -> the requesting user's admin locale (cookie /
 * Accept-Language, i.e. the language the inviter works in) -> English.
 */

import { matchLocale, resolveLocale } from "@emdash-cms/admin/locales/config";

export function resolveEmailLocale(siteLocale: unknown, request: Request): string {
	if (typeof siteLocale === "string" && siteLocale) {
		// Canonicalize free-form option values ("pt-br" -> "pt-BR") so they
		// find their catalog; unsupported values fall through to the
		// requester's locale.
		const matched = matchLocale(siteLocale);
		if (matched) return matched;
	}
	return resolveLocale(request);
}
