/**
 * Local-only types for the bundling pipeline.
 *
 * The cross-package manifest contract (capabilities, manifest shape, hook
 * entries, etc.) lives in `@emdash-cms/plugin-types` and is re-exported from
 * here for convenience so the bundling internals only need one import.
 *
 * The only type that doesn't go upstream is `ResolvedPlugin`: it's the
 * loose internal shape the bundler reads from a user plugin's compiled
 * `createPlugin()` / descriptor-factory output. Core has its own canonical,
 * tightly-typed `ResolvedPlugin` that we don't want to depend on (it pulls
 * in Astro / blocks / schema). Both sides exist in service of the same
 * manifest contract; they don't need to share the runtime shape.
 */

export {
	CAPABILITY_RENAMES,
	isDeprecatedCapability,
	type CurrentPluginCapability,
	type DeprecatedPluginCapability,
	type ManifestHookEntry,
	type ManifestRouteEntry,
	type PluginAdminConfig,
	type PluginCapability,
	type PluginManifest,
	type PluginStorageConfig,
	type StorageCollectionConfig,
} from "@emdash-cms/plugin-types";

import type {
	PluginAdminConfig,
	PluginCapability,
	PluginStorageConfig,
} from "@emdash-cms/plugin-types";

/**
 * The bundler's view of a "resolved" plugin -- whatever the user's plugin
 * module exposes after we build + import it. Loose by design: the third-party
 * code we're loading may follow several formats (native `createPlugin`,
 * descriptor factory, default object), and we extract a manifest from any of
 * them. Treat field absence as "not declared".
 */
export interface ResolvedPlugin {
	id: string;
	version: string;
	capabilities: PluginCapability[];
	allowedHosts: string[];
	storage: PluginStorageConfig;
	hooks: Record<
		string,
		{
			handler?: unknown;
			priority?: number;
			timeout?: number;
			dependencies?: string[];
			errorPolicy?: string;
			exclusive?: boolean;
			pluginId?: string;
		}
	>;
	routes: Record<
		string,
		{
			handler?: unknown;
			public?: boolean;
		}
	>;
	admin: PluginAdminConfig;
}
