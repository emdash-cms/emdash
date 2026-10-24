/**
 * Robots.txt endpoint
 *
 * GET /robots.txt - Serves robots.txt with sitemap reference
 *
 * If a custom robots.txt is configured in SEO settings, that is returned.
 * Otherwise generates a default that allows all crawlers and references
 * the sitemap. When `seo.disallowAiTraining` is set, either version gets
 * rules asking AI training crawlers to stay away.
 */

import type { APIRoute } from "astro";

import { getPublicOrigin } from "#api/public-url.js";
import { getSiteSettingsWithDb } from "#settings/index.js";

export const prerender = false;

const TRAILING_SLASH_RE = /\/$/;

/** AI training crawlers and opt-out tokens, as listed in Cloudflare's managed robots.txt. */
const AI_TRAINING_CRAWLERS = [
	"Amazonbot",
	"Applebot-Extended",
	"Bytespider",
	"CCBot",
	"ClaudeBot",
	"Google-Extended",
	"GPTBot",
	"meta-externalagent",
];

/**
 * `Content-Signal` is not a rule, so the empty `Disallow:` is what closes the
 * `*` group; without a rule, crawlers merge it with the next group and apply
 * `Disallow: /` to everyone.
 */
const AI_TRAINING_RULES = [
	"# Disallow AI training",
	"User-agent: *",
	"Content-Signal: search=yes, ai-train=no",
	"Disallow:",
	...AI_TRAINING_CRAWLERS.flatMap((agent) => ["", `User-agent: ${agent}`, "Disallow: /"]),
].join("\n");

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
		const disallowAiTraining = settings.seo?.disallowAiTraining === true;

		// Use custom robots.txt if configured
		if (settings.seo?.robotsTxt) {
			let content = settings.seo.robotsTxt;
			if (disallowAiTraining) {
				content = `${content.trimEnd()}\n\n${AI_TRAINING_RULES}\n`;
			}
			// Append sitemap directive if not already present
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
			...(disallowAiTraining ? [AI_TRAINING_RULES, ""] : []),
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
