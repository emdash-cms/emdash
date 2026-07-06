/**
 * Per-collection sitemap endpoint
 *
 * GET /sitemap-{collection}.xml - Sitemap for a single content collection.
 *
 * Uses the collection's url_pattern to build URLs. Falls back to
 * /{collection}/{slug} when no pattern is configured.
 *
 * i18n behaviour: when Astro i18n is enabled, the locale prefix is
 * applied via Astro's own `getRelativeLocaleUrl` (which honours
 * `prefixDefaultLocale`, custom `path` mappings, and other `routing`
 * config). Each translation row is emitted as its own `<url>` with
 * `<xhtml:link rel="alternate" hreflang="...">` entries pointing to
 * its siblings (grouped by `translation_group`). The default-locale
 * variant is also linked as `hreflang="x-default"`.
 */

import type { APIRoute } from "astro";

import { handleSitemapData } from "#api/handlers/seo.js";
import { getPublicOrigin } from "#api/public-url.js";
import { getSiteSettingsWithDb } from "#settings/index.js";

import { getI18nConfig, isI18nEnabled } from "../../i18n/config.js";
import { interpolateUrlPattern, localizePath } from "../../i18n/resolve.js";
import { buildSeoImageUrl } from "../../seo/media-url.js";

export const prerender = false;

const TRAILING_SLASH_RE = /\/$/;
const AMP_RE = /&/g;
const LT_RE = /</g;
const GT_RE = />/g;
const QUOT_RE = /"/g;
const APOS_RE = /'/g;

export const GET: APIRoute = async ({ params, locals, url }) => {
	const { emdash } = locals;
	const collectionSlug = params.collection;

	if (!emdash?.db || !collectionSlug) {
		return new Response("<!-- EmDash not configured -->", {
			status: 500,
			headers: { "Content-Type": "application/xml" },
		});
	}

	try {
		const settings = await getSiteSettingsWithDb(emdash.db);
		const siteUrl = (settings.url || getPublicOrigin(url, emdash?.config)).replace(
			TRAILING_SLASH_RE,
			"",
		);

		const result = await handleSitemapData(emdash.db, collectionSlug);

		if (!result.success || !result.data) {
			return new Response("<!-- Failed to generate sitemap -->", {
				status: 500,
				headers: { "Content-Type": "application/xml" },
			});
		}

		const col = result.data.collections[0];
		if (!col) {
			return new Response("<!-- Collection not found or empty -->", {
				status: 404,
				headers: { "Content-Type": "application/xml" },
			});
		}

		const i18nEnabled = isI18nEnabled();
		const i18nConfig = getI18nConfig();

		// Group entries by `translation_group` so each <url> can advertise
		// its sibling translations via xhtml:link. Rows without a group
		// (legacy/single-locale data) are emitted individually.
		type Entry = (typeof col.entries)[number];
		const groups = new Map<string, Entry[]>();
		const ungrouped: Entry[] = [];
		for (const entry of col.entries) {
			if (i18nEnabled && entry.translationGroup) {
				const list = groups.get(entry.translationGroup);
				if (list) list.push(entry);
				else groups.set(entry.translationGroup, [entry]);
			} else {
				ungrouped.push(entry);
			}
		}

		// Resolve every URL up-front so we can reference sibling URLs
		// while emitting hreflang alternates without re-resolving.
		// `localizePath` returns `null` when the row's locale isn't in
		// the configured `i18n.locales` list -- the site can't serve a
		// route for it, so the entry is dropped from the sitemap and
		// omitted from sibling alternates.
		const urlByEntry = new Map<string, string | null>();
		const resolveEntryUrl = async (entry: Entry): Promise<string | null> => {
			if (urlByEntry.has(entry.id)) return urlByEntry.get(entry.id) ?? null;
			const path = interpolateUrlPattern({
				pattern: col.urlPattern,
				collection: col.collection,
				slug: entry.slug || entry.id,
				id: entry.id,
			});
			const localized = await localizePath(path, entry.locale);
			const absolute = localized === null ? null : `${siteUrl}${localized}`;
			urlByEntry.set(entry.id, absolute);
			return absolute;
		};

		const useXhtml = i18nEnabled;
		const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
		lines.push(
			useXhtml
				? '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">'
				: '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
		);

		const writeUrl = async (entry: Entry, siblings: Entry[] | null) => {
			const loc = await resolveEntryUrl(entry);
			// Skip rows whose locale isn't in the configured `i18n.locales`
			// list. Linking to a route the site can't serve is worse than
			// no link at all (search engines hit a 404 and downrank).
			if (loc === null) return;

			lines.push("  <url>");
			lines.push(`    <loc>${escapeXml(loc)}</loc>`);
			lines.push(`    <lastmod>${escapeXml(entry.updatedAt)}</lastmod>`);

			// Google image sitemap extension: advertise the entry's SEO
			// image (the same "preferred image" used for og:image) so it
			// can be discovered and indexed for Google Images.
			if (entry.image) {
				const imageLoc = buildSeoImageUrl(entry.image, siteUrl);
				lines.push("    <image:image>");
				lines.push(`      <image:loc>${escapeXml(imageLoc)}</image:loc>`);
				lines.push("    </image:image>");
			}

			const alternateEntries = siblings ?? (useXhtml ? [entry] : null);
			if (useXhtml && alternateEntries) {
				// Emit one xhtml:link per sibling (including self -- Google
				// recommends including the page's own hreflang annotation).
				// Siblings with unroutable locales are skipped here too.
				for (const sib of alternateEntries) {
					const sibLoc = await resolveEntryUrl(sib);
					if (sibLoc === null) continue;
					lines.push(
						`    <xhtml:link rel="alternate" hreflang="${escapeXml(sib.locale)}" href="${escapeXml(sibLoc)}" />`,
					);
				}

				// x-default: prefer the default-locale sibling, otherwise
				// the first sibling with a routable URL. Stable order:
				// rows arrive sorted by updated_at DESC from the handler.
				const defaultSibling =
					i18nConfig && alternateEntries.find((s) => s.locale === i18nConfig.defaultLocale);
				let xDefaultLoc: string | null = null;
				if (defaultSibling) {
					xDefaultLoc = await resolveEntryUrl(defaultSibling);
				}
				if (xDefaultLoc === null) {
					for (const sib of alternateEntries) {
						const sibLoc = await resolveEntryUrl(sib);
						if (sibLoc !== null) {
							xDefaultLoc = sibLoc;
							break;
						}
					}
				}
				if (xDefaultLoc !== null) {
					lines.push(
						`    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(xDefaultLoc)}" />`,
					);
				}
			}

			lines.push("  </url>");
		};

		for (const siblings of groups.values()) {
			for (const entry of siblings) {
				await writeUrl(entry, siblings);
			}
		}
		for (const entry of ungrouped) {
			await writeUrl(entry, null);
		}

		lines.push("</urlset>");

		return new Response(lines.join("\n"), {
			status: 200,
			headers: {
				"Content-Type": "application/xml; charset=utf-8",
				"Cache-Control": "public, max-age=3600",
			},
		});
	} catch {
		return new Response("<!-- Internal error generating sitemap -->", {
			status: 500,
			headers: { "Content-Type": "application/xml" },
		});
	}
};

/** Escape special XML characters in a string */
function escapeXml(str: string): string {
	return str
		.replace(AMP_RE, "&amp;")
		.replace(LT_RE, "&lt;")
		.replace(GT_RE, "&gt;")
		.replace(QUOT_RE, "&quot;")
		.replace(APOS_RE, "&apos;");
}
