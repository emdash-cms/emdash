/**
 * AT Protocol / standard.site Plugin for EmDash CMS
 *
 * Syndicates published content to the AT Protocol network using the
 * standard.site lexicons, with optional cross-posting to Bluesky.
 *
 * Features:
 * - Creates site.standard.publication record (one per site)
 * - Creates site.standard.document records on publish
 * - Optional Bluesky cross-post with link card
 * - Automatic <link rel="site.standard.document"> injection via page:metadata
 * - Sync status tracking in plugin storage
 *
 * Designed for sandboxed execution:
 * - All HTTP via ctx.http.fetch()
 * - Block Kit admin UI (no React components)
 * - Capabilities: content:read, network:request:unrestricted
 */

import type { PluginDescriptor } from "emdash";

import { version } from "../package.json";

// ── Descriptor ──────────────────────────────────────────────────

/**
 * Create the AT Protocol plugin descriptor.
 * Import this in your astro.config.mjs / live.config.ts.
 */
export function atprotoPlugin(): PluginDescriptor {
	return {
		id: "atproto",
		version,
		format: "standard",
		entrypoint: "@emdash-cms/plugin-atproto/sandbox",
		capabilities: ["content:read", "network:request:unrestricted"],
		storage: {
			records: { indexes: ["contentId", "status", "lastSyncedAt"] },
		},
		// Block Kit admin pages (no adminEntry needed -- sandboxed)
		adminPages: [{ path: "/status", label: "AT Protocol", icon: "globe" }],
		adminWidgets: [{ id: "sync-status", title: "AT Protocol", size: "third" }],
	};
}
