/**
 * Content Strategy Plugin for EmDash CMS
 *
 * Analyzes published content across collections and suggests improvements.
 * Identifies content gaps, stale posts, and missing SEO metadata.
 *
 * Features:
 * - Content gap analysis across all collections
 * - Stale content detection (posts older than 90 days without updates)
 * - Missing SEO metadata identification
 * - Per-collection content health scoring
 * - Admin dashboard with strategy overview
 *
 * Replaces: editorial-calendar, publishpress
 */

import type { PluginDescriptor } from "emdash";

/**
 * Create the content strategy plugin descriptor
 */
export function contentStrategyPlugin(): PluginDescriptor {
	return {
		id: "content-strategy",
		version: "0.1.0",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-content-strategy/sandbox",
		capabilities: ["read:content"],
		adminPages: [{ path: "/dashboard", label: "Content Strategy", icon: "chart-bar" }],
		adminWidgets: [{ id: "overview", title: "Content Strategy", size: "third" }],
	};
}
