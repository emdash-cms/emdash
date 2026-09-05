/**
 * Resolve the locale for outbound system emails (invite, magic link,
 * recovery), and load the matching localized copy from the admin
 * catalogs (#915).
 *
 * Priority: the site-wide `emdash:locale` option (explicit site
 * language) -> the requesting user's admin locale (cookie /
 * Accept-Language, i.e. the language the inviter works in) -> English.
 * The recipient's language is unknowable server-side, so the site's
 * language is the best available signal — same trade-off WordPress
 * makes for its system mails.
 */

import { resolveLocale } from "@emdash-cms/admin/locales";
import type { Kysely } from "kysely";

import { OptionsRepository } from "../database/repositories/options.js";
import type { Database } from "../database/types.js";

export async function getEmailLocale(db: Kysely<Database>, request: Request): Promise<string> {
	const options = new OptionsRepository(db);
	const siteLocale = await options.get<string>("emdash:locale");
	// loadMessages falls back to English for unsupported codes, so a
	// free-form option value degrades safely.
	if (typeof siteLocale === "string" && siteLocale) return siteLocale;
	return resolveLocale(request);
}
