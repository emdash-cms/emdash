/**
 * Sitemap XML endpoint
 *
 * GET /sitemap.xml - Auto-generated sitemap from published content
 *
 * Includes all published, non-noindex content across all collections.
 * The site URL is read from site settings or the request URL origin.
 *
 * Default URL pattern: /{collection}/{slug-or-id}. Users can override
 * by creating their own /sitemap.xml route in their Astro project.
 */

import type { APIRoute } from "astro";

import { handleSitemapData } from "#api/handlers/seo.js";
import { getPublicOrigin } from "#api/public-url.js";
import { getSiteSettingsWithDb } from "#settings/index.js";

export const prerender = false;

const TRAILING_SLASH_RE = /\/$/;
const AMP_RE = /&/g;
const LT_RE = /</g;
const GT_RE = />/g;
const QUOT_RE = /"/g;
const APOS_RE = /'/g;

export const GET: APIRoute = async ({ locals, url }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return new Response("<!-- EmDash not configured -->", {
			status: 500,
			headers: { "Content-Type": "application/xml" },
		});
	}

	try {
		// Determine site URL from settings or request origin
		const settings = await getSiteSettingsWithDb(emdash.db);
		const siteUrl = (settings.url || getPublicOrigin(url, emdash?.config)).replace(
			TRAILING_SLASH_RE,
			"",
		);

		const result = await handleSitemapData(emdash.db);

		if (!result.success || !result.data) {
			return new Response("<!-- Failed to generate sitemap -->", {
				status: 500,
				headers: { "Content-Type": "application/xml" },
			});
		}

		const entries = result.data.entries;

		// Build XML
		const lines: string[] = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
		];

		for (const entry of entries) {
			// Default URL pattern: /{collection}/{identifier}
			// Encode path segments to handle slugs with spaces/unicode/reserved chars
			const loc = `${siteUrl}/${encodeURIComponent(entry.collection)}/${encodeURIComponent(entry.identifier)}`;

			lines.push("  <url>");
			lines.push(`    <loc>${escapeXml(loc)}</loc>`);
			lines.push(`    <lastmod>${escapeXml(entry.updatedAt)}</lastmod>`);
			lines.push("    <changefreq>weekly</changefreq>");
			lines.push("    <priority>0.7</priority>");
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
