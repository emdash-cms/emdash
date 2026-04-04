/**
 * SEO Plugin for EmDash CMS
 *
 * Adds sitemap.xml generation, meta tag validation, and robots.txt management.
 * Replaces: yoast-seo, rank-math-seo, all-in-one-seo-pack
 *
 * Features:
 * - Automatic sitemap.xml from published content
 * - Meta title/description validation with character count warnings
 * - Open Graph tag completeness checking
 * - robots.txt configuration via admin settings
 * - Per-entry noindex/nofollow controls (via SEO metadata)
 *
 * Uses EmDash's built-in SEO metadata system (data.seo on content entries)
 * and extends it with validation, sitemap generation, and robots.txt.
 */

import type { PluginDescriptor } from "emdash";

export function seoPlugin(): PluginDescriptor {
	return {
		id: "seo",
		version: "0.1.0",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-seo/sandbox",
		capabilities: ["read:content"],
		replaces: ["yoast-seo", "rank-math-seo", "all-in-one-seo-pack"],
		storage: {
			settings: {},
		},
		settings: {
			robotsTxt: {
				type: "text",
				label: "robots.txt",
				description: "Custom robots.txt content. Leave empty for default.",
				default: "",
			},
			sitemapEnabled: {
				type: "boolean",
				label: "Enable sitemap.xml",
				description: "Automatically generate a sitemap from published content.",
				default: true,
			},
			sitemapCollections: {
				type: "string",
				label: "Sitemap collections",
				description: "Comma-separated list of collections to include. Leave empty for all.",
				default: "",
			},
		},
		adminPages: [{ path: "/overview", label: "SEO Overview", icon: "search" }],
		routes: [
			{ method: "GET", path: "/sitemap.xml", handler: "handleSitemap" },
			{ method: "GET", path: "/robots.txt", handler: "handleRobots" },
		],
	};
}

export default seoPlugin;
