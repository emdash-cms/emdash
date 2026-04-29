/**
 * Field Kit Plugin for EmDash CMS
 *
 * Provides composable field widgets for `json` fields configured entirely
 * through seed options — no React code required from site builders.
 *
 * Ships four widgets:
 *   - object-form — inline form for flat JSON objects
 *   - list        — ordered array editor with add/remove/reorder
 *   - grid        — rows × columns matrix with configurable cell type
 *   - tags        — free-form tag/chip input for string arrays
 *
 * Usage in astro.config.mjs:
 *   import { fieldKitPlugin } from "@emdash-cms/plugin-field-kit";
 *   emdash({ plugins: [fieldKitPlugin()] });
 *
 * Usage in a seed field:
 *   {
 *     "slug": "ingredients",
 *     "type": "json",
 *     "widget": "field-kit:list",
 *     "options": { "fields": [...], "summary": "{{name}}" }
 *   }
 */

import type { PluginDescriptor } from "emdash";
import { definePlugin } from "emdash";

const PLUGIN_ID = "field-kit";
const PLUGIN_VERSION = "0.0.0";

/**
 * Create the field-kit plugin instance.
 * Called by the virtual module system at runtime.
 */
export function createPlugin() {
	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		admin: {
			entry: "@emdash-cms/plugin-field-kit/admin",
			fieldWidgets: [
				{ name: "object-form", label: "Object form", fieldTypes: ["json"] },
				{ name: "list", label: "List", fieldTypes: ["json"] },
				{ name: "grid", label: "Grid", fieldTypes: ["json"] },
				{ name: "tags", label: "Tags input", fieldTypes: ["json"] },
			],
		},
	});
}

export default createPlugin;

/**
 * Create a plugin descriptor for use in emdash config.
 */
export function fieldKitPlugin(): PluginDescriptor {
	return {
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		entrypoint: "@emdash-cms/plugin-field-kit",
		options: {},
		adminEntry: "@emdash-cms/plugin-field-kit/admin",
	};
}
