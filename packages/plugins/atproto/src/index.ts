/**
 * AT Protocol / standard.site Plugin for EmDash CMS
 *
 * This package supports both descriptor + native entrypoint usage.
 *
 * Descriptor mode:
 * - `atprotoPlugin()` returns a `PluginDescriptor` for config.
 * - Runtime uses standard format + sandbox/inline adaptation.
 *
 * Native mode:
 * - `createPlugin()` returns a resolved plugin via `definePlugin`.
 */

import type { PluginDefinition, PluginDescriptor, ResolvedPlugin } from "emdash";
import { definePlugin } from "emdash";

import sandboxPlugin from "./sandbox-entry.js";

const ATPROTO_PLUGIN_ID = "atproto";
const ATPROTO_PLUGIN_VERSION = "0.1.0";

interface AtprotoPluginOptions {
	// Placeholder for future options to preserve constructor signature.
	[key: string]: unknown;
}

/**
 * Create the AT Protocol plugin descriptor.
 * Import this in your astro.config.mjs / live.config.ts.
 */
export function atprotoPlugin(
	options: AtprotoPluginOptions = {},
): PluginDescriptor<AtprotoPluginOptions> {
	return {
		id: ATPROTO_PLUGIN_ID,
		version: ATPROTO_PLUGIN_VERSION,
		format: "standard",
		entrypoint: "@emdash-cms/plugin-atproto",
		options,
		capabilities: ["read:content", "network:fetch:any"],
		storage: {
			records: { indexes: ["contentId", "status"] },
		},
		// Block Kit admin pages (no adminEntry needed -- sandboxed)
		adminPages: [{ path: "/status", label: "AT Protocol", icon: "globe" }],
		adminWidgets: [{ id: "sync-status", title: "AT Protocol", size: "third" }],
	};
}

/**
 * Native plugin factory.
 *
 * Uses the sandbox implementation as the source of hook/route behavior
 * and adapts it into a fully resolved plugin.
 */
export function createPlugin(_options: AtprotoPluginOptions = {}): ResolvedPlugin {
	const hooks = {
		...(sandboxPlugin.hooks as Record<string, unknown>),
		"content:afterSave": {
			...(sandboxPlugin.hooks?.["content:afterSave"] as Record<string, unknown>),
			errorPolicy: "continue",
		},
	} as Record<string, any>;

	return definePlugin({
		id: ATPROTO_PLUGIN_ID,
		version: ATPROTO_PLUGIN_VERSION,
		capabilities: ["read:content", "network:fetch:any"],
		storage: {
			records: { indexes: ["contentId", "status"] },
		},
		hooks,
		routes: sandboxPlugin.routes as Record<string, any>,
		admin: {
			settingsSchema: {
				handle: { type: "string", label: "Handle" },
				appPassword: { type: "secret", label: "App Password" },
				siteUrl: { type: "string", label: "Site URL" },
				enableBskyCrosspost: { type: "boolean", label: "Enable Bluesky crosspost" },
				crosspostTemplate: { type: "string", label: "Crosspost template" },
				langs: { type: "string", label: "Languages" },
			},
		},
	} as PluginDefinition);
}

export default sandboxPlugin;
