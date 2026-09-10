/**
 * Resolve the locale for outbound system emails (invite, magic link,
 * recovery). Callers read the `emdash:locale` option (batched with
 * their other options reads) and load the matching localized copy from
 * the admin catalogs.
 *
 * Priority: the site-wide `emdash:locale` option (explicit site
 * language) -> the requesting user's admin locale (cookie /
 * Accept-Language, i.e. the language the inviter works in) -> English.
 */

import { matchLocale, resolveLocale } from "@emdash-cms/admin/locales";

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
