export {
	CURRENT_PLUGIN_CAPABILITIES,
	DEPRECATED_PLUGIN_CAPABILITIES,
	HOOK_NAMES,
	normalizeManifestHook,
	normalizeManifestRoute,
	PLUGIN_CAPABILITIES,
	pluginManifestSchema,
} from "@emdash-cms/plugin-types";
import { reconcileManifestAccess as reconcileSharedManifestAccess } from "@emdash-cms/plugin-types";
import type { ValidatedPluginManifest } from "@emdash-cms/plugin-types";

import type { PluginManifest } from "./types.js";

export type { ValidatedPluginManifest } from "@emdash-cms/plugin-types";

export function reconcileManifestAccess(manifest: ValidatedPluginManifest): PluginManifest {
	// The shared schema restricts hook names to core's known hook vocabulary;
	// plugin-types intentionally keeps its standalone wire type open-ended.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- schema validation is the runtime narrowing boundary
	return reconcileSharedManifestAccess(manifest) as unknown as PluginManifest;
}
