/**
 * Robots.txt endpoint
 *
 * GET /robots.txt - Serves robots.txt with sitemap reference
 *
 * If a custom robots.txt is configured in SEO settings, that is returned.
 * Otherwise generates a default that allows all crawlers and references
 * the sitemap.
 */

import type { APIRoute } from "astro";

import { getPublicOrigin } from "#api/public-url.js";
import { getSiteSettingsWithDb } from "#settings/index.js";

export const prerender = false;

const TRAILING_SLASH_RE = /\/$/;

export const GET: APIRoute = async ({ locals, url }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		// Return a permissive default if CMS isn't initialized
		return new Response("User-agent: *\nAllow: /\n", {
			status: 200,
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	}

	try {
		const settings = await getSiteSettingsWithDb(emdash.db);
		const siteUrl = (settings.url || getPublicOrigin(url, emdash?.config)).replace(
			TRAILING_SLASH_RE,
			"",
		);
		const sitemapUrl = `${siteUrl}/sitemap.xml`;

		// Use custom robots.txt if configured
		if (settings.seo?.robotsTxt) {
			// Append sitemap directive if not already present
			let content = settings.seo.robotsTxt;
			if (!content.toLowerCase().includes("sitemap:")) {
				content = `${content.trimEnd()}\n\nSitemap: ${sitemapUrl}\n`;
			}

			return new Response(content, {
				status: 200,
				headers: {
					"Content-Type": "text/plain; charset=utf-8",
					"Cache-Control": "public, max-age=86400",
				},
			});
		}

		// Generate default robots.txt
		const defaultRobots = [
			"User-agent: *",
			"Allow: /",
			"",
			"# Disallow admin and API routes",
			"Disallow: /_emdash/",
			"",
			`Sitemap: ${sitemapUrl}`,
			"",
		].join("\n");

		return new Response(defaultRobots, {
			status: 200,
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "public, max-age=86400",
			},
		});
	} catch {
		return new Response("User-agent: *\nAllow: /\n", {
			status: 200,
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	}
};
