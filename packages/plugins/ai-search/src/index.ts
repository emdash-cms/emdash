/**
 * Cloudflare AI Search for EmDash.
 *
 * Indexes published content and author profiles into an AI Search instance and
 * serves a public search route. Runs only on Cloudflare Workers, with an
 * `ai_search_namespaces` binding.
 *
 * @example
 * ```js
 * // astro.config.mjs
 * import { aiSearch } from "@emdash-cms/plugin-ai-search";
 *
 * emdash({ plugins: [aiSearch()] });
 * ```
 */

import type { PluginCapability, PluginDescriptor, ResolvedPlugin } from "emdash";
import { definePlugin } from "emdash";

import { version } from "../package.json";
import { createHooks } from "./hooks.js";
import { type AiSearchOptions, resolveOptions } from "./options.js";
import { createRoutes } from "./routes.js";
import { SNAPSHOT } from "./snapshot.js";

export type { AiSearchOptions } from "./options.js";

const ID = "ai-search";
const CAPABILITIES: PluginCapability[] = [
	"content:read",
	"schema:read",
	"bylines:read",
	"media:read",
	"taxonomies:read",
];
const ADMIN_ENTRY = "@emdash-cms/plugin-ai-search/admin";
const ADMIN_PAGES = [{ path: "/settings", label: "AI Search", icon: "search" }];
const ADMIN_WIDGETS = [{ id: "status", title: "AI Search", size: "half" as const }];
const STORAGE = { [SNAPSHOT]: { indexes: ["source"] } };

export function aiSearch(
	options: Partial<AiSearchOptions> = {},
): PluginDescriptor<Partial<AiSearchOptions>> {
	return {
		id: ID,
		version,
		entrypoint: "@emdash-cms/plugin-ai-search",
		format: "native",
		options,
		capabilities: CAPABILITIES,
		adminEntry: ADMIN_ENTRY,
		adminPages: ADMIN_PAGES,
		adminWidgets: ADMIN_WIDGETS,
		storage: STORAGE,
	};
}

export function createPlugin(options: Partial<AiSearchOptions> = {}): ResolvedPlugin {
	const resolved = resolveOptions(options);
	return definePlugin({
		id: ID,
		version,
		capabilities: CAPABILITIES,
		admin: { entry: ADMIN_ENTRY, pages: ADMIN_PAGES, widgets: ADMIN_WIDGETS },
		storage: STORAGE,
		hooks: createHooks(resolved),
		routes: createRoutes(resolved),
	});
}
