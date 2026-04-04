/**
 * SEO Plugin - Sandbox entry point
 *
 * Runs inside the plugin sandbox with declared capabilities only.
 */

import { definePlugin } from "emdash";

const AMP_RE = /&/g;
const LT_RE = /</g;
const GT_RE = />/g;
const QUOT_RE = /"/g;

export default () =>
	definePlugin({
		id: "seo",
		capabilities: ["read:content"],
		hooks: {
			/**
			 * After content is saved, validate SEO metadata and log warnings.
			 */
			"content:afterSave": async (event, _ctx) => {
				const { data } = event.content;
				const seo = data.seo as
					| { title?: string; description?: string; ogTitle?: string; ogImage?: string }
					| undefined;

				if (!seo) return;

				const warnings: string[] = [];

				// Title length check (Google truncates at ~60 chars)
				if (seo.title && seo.title.length > 60) {
					warnings.push(`SEO title is ${seo.title.length} chars (recommended: under 60)`);
				}

				// Description length check (Google truncates at ~160 chars)
				if (seo.description && seo.description.length > 160) {
					warnings.push(
						`SEO description is ${seo.description.length} chars (recommended: under 160)`,
					);
				}

				// Missing OG image
				if (!seo.ogImage) {
					warnings.push("No Open Graph image set. Social shares will use a default image.");
				}

				if (warnings.length > 0) {
					console.log(`[seo] Warnings for "${data.title || "Untitled"}":`, warnings);
				}
			},
		},
		routes: {
			/**
			 * Generate sitemap.xml from published content
			 */
			handleSitemap: async (_req, ctx) => {
				const settings = await ctx.storage.get("settings", "config");
				const enabled = settings?.sitemapEnabled !== false;

				if (!enabled) {
					return new Response("Sitemap generation is disabled", { status: 404 });
				}

				// Query all published content
				const collections = await ctx.content.listCollections();
				const allowedCollections = settings?.sitemapCollections
					? String(settings.sitemapCollections)
							.split(",")
							.map((s: string) => s.trim())
							.filter(Boolean)
					: null;

				const urls: Array<{ loc: string; lastmod: string; priority: string }> = [];

				for (const collection of collections) {
					if (allowedCollections && !allowedCollections.includes(collection.slug)) {
						continue;
					}

					const items = await ctx.content.list(collection.slug, {
						status: "published",
						limit: 1000,
					});

					for (const item of items.items) {
						const seo = item.data?.seo as { robots?: string } | undefined;
						// Skip noindex entries
						if (seo?.robots?.includes("noindex")) continue;

						urls.push({
							loc: `/${collection.slug}/${item.slug}`,
							lastmod: item.updatedAt || item.createdAt,
							priority: collection.slug === "pages" ? "0.8" : "0.6",
						});
					}
				}

				const xml = buildSitemapXml(urls);
				return new Response(xml, {
					headers: {
						"Content-Type": "application/xml",
						"Cache-Control": "public, max-age=3600",
					},
				});
			},

			/**
			 * Serve robots.txt from plugin settings
			 */
			handleRobots: async (_req, ctx) => {
				const settings = await ctx.storage.get("settings", "config");
				const custom = settings?.robotsTxt;

				const content =
					custom || ["User-agent: *", "Allow: /", "", "Sitemap: /sitemap.xml"].join("\n");

				return new Response(content, {
					headers: {
						"Content-Type": "text/plain",
						"Cache-Control": "public, max-age=86400",
					},
				});
			},
		},
	});

function buildSitemapXml(urls: Array<{ loc: string; lastmod: string; priority: string }>): string {
	const entries = urls
		.map(
			(u) =>
				`  <url>\n    <loc>${escapeXml(u.loc)}</loc>\n    <lastmod>${u.lastmod.split("T")[0]}</lastmod>\n    <priority>${u.priority}</priority>\n  </url>`,
		)
		.join("\n");

	return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>`;
}

function escapeXml(str: string): string {
	return str
		.replace(AMP_RE, "&amp;")
		.replace(LT_RE, "&lt;")
		.replace(GT_RE, "&gt;")
		.replace(QUOT_RE, "&quot;");
}
