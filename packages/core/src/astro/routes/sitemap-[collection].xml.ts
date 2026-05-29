/**
 * Per-collection sitemap endpoint
 *
 * GET /sitemap-{collection}.xml - Sitemap for a single content collection.
 *
 * Uses the collection's url_pattern to build URLs. Falls back to
 * /{collection}/{slug} when no pattern is configured.
 */

import type { APIRoute } from "astro";
// @ts-ignore - virtual module populated by the EmDash integration
import virtualConfig from "virtual:emdash/config";

import { handleSitemapData } from "#api/handlers/seo.js";
import { getSiteSettingsWithDb } from "#settings/index.js";

interface VirtualI18nConfig {
	defaultLocale: string;
	locales: string[];
	prefixDefaultLocale?: boolean;
}

export const prerender = false;

const TRAILING_SLASH_RE = /\/$/;
const AMP_RE = /&/g;
const LT_RE = /</g;
const GT_RE = />/g;
const QUOT_RE = /"/g;
const APOS_RE = /'/g;
const SLUG_PLACEHOLDER = "{slug}";
const ID_PLACEHOLDER = "{id}";

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
		const siteUrl = (settings.url || url.origin).replace(TRAILING_SLASH_RE, "");

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

		const lines: string[] = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
		];

		// Read i18n straight from the virtual config (same source the loader uses),
		// so we don't depend on middleware having initialized getI18nConfig().
		const i18nCfg: VirtualI18nConfig | null =
			virtualConfig && typeof virtualConfig === "object" && "i18n" in virtualConfig
				? ((virtualConfig as { i18n?: VirtualI18nConfig }).i18n ?? null)
				: null;
		const i18nOn = i18nCfg !== null && i18nCfg.locales.length > 1;

		for (const entry of col.entries) {
			const slug = entry.slug || entry.id;
			const basePath = col.urlPattern
				? col.urlPattern
						.replace(SLUG_PLACEHOLDER, encodeURIComponent(slug))
						.replace(ID_PLACEHOLDER, encodeURIComponent(entry.id))
				: `/${encodeURIComponent(col.collection)}/${encodeURIComponent(slug)}`;

			// Mirror loader.ts: prefix with /<locale> when i18n is on and the row
			// isn't the default locale (or prefixDefaultLocale is enabled).
			const shouldPrefix =
				i18nOn &&
				i18nCfg !== null &&
				entry.locale !== "" &&
				(entry.locale !== i18nCfg.defaultLocale || i18nCfg.prefixDefaultLocale === true);
			const path = shouldPrefix ? `/${encodeURIComponent(entry.locale)}${basePath}` : basePath;

			const loc = `${siteUrl}${path}`;

			lines.push("  <url>");
			lines.push(`    <loc>${escapeXml(loc)}</loc>`);
			lines.push(`    <lastmod>${escapeXml(entry.updatedAt)}</lastmod>`);
			lines.push("  </url>");
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
