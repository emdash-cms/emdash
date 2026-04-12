/**
 * Sitemap index endpoint
 *
 * GET /sitemap.xml - Sitemap index listing one sitemap per collection.
 *
 * Each collection with published, indexable content gets its own
 * child sitemap at /sitemap-{collection}.xml. The index includes
 * a <lastmod> per child derived from the most recently updated entry.
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

		const { collections } = result.data;

		const lines: string[] = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
		];

		for (const col of collections) {
			const loc = `${siteUrl}/sitemap-${encodeURIComponent(col.collection)}.xml`;
			lines.push("  <sitemap>");
			lines.push(`    <loc>${escapeXml(loc)}</loc>`);
			lines.push(`    <lastmod>${escapeXml(col.lastmod)}</lastmod>`);
			lines.push("  </sitemap>");
		}

		lines.push("</sitemapindex>");

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
