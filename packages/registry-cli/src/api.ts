/**
 * Programmatic API for `@emdash-cms/registry-cli`.
 *
 * Most users will run the CLI binary `emdash-registry`. This entry exists for
 * tooling -- editors, custom build scripts, or other CLIs -- that want to
 * invoke the same logic without spawning a subprocess.
 *
 * For discovery and credential storage, import from `@emdash-cms/registry-client`
 * directly. This package is the publisher-side surface (bundle, publish).
 *
 * EXPERIMENTAL: pin to an exact version while RFC 0001 is in flight.
 */

export {
	type BundleErrorCode,
	type BundleLogger,
	type BundleOptions,
	type BundleResult,
	BundleError,
	bundlePlugin,
} from "./bundle/api.js";

export {
	type ProfileBootstrap,
	type PublishErrorCode,
	type PublishLogger,
	type PublishOptions,
	type PublishResult,
	PublishError,
	publishRelease,
} from "./publish/api.js";

// `sanitiseSlug` was previously exported from `./publish/api.js`. The
// canonical helper now lives in `@emdash-cms/plugin-types` as
// `deriveSlugFromId` (alongside the validation regex constants and
// `isPluginSlug`); we re-export it here for one release cycle to ease
// migration. New code should import from `@emdash-cms/plugin-types` directly.
export {
	deriveSlugFromId,
	isPluginSlug,
	isPluginVersion,
	PLUGIN_SLUG_RE,
	PLUGIN_VERSION_RE,
} from "@emdash-cms/plugin-types";

// Re-export the manifest contract types so consumers don't need a separate
// `@emdash-cms/plugin-types` dep just to type their input/output. They're
// authored upstream; this is a convenience surface, not a copy.
export {
	type CurrentPluginCapability,
	type DeprecatedPluginCapability,
	type ManifestHookEntry,
	type ManifestRouteEntry,
	type PluginAdminConfig,
	type PluginCapability,
	type PluginManifest,
	type PluginStorageConfig,
	type StorageCollectionConfig,
	CAPABILITY_RENAMES,
	isDeprecatedCapability,
	normalizeCapabilities,
	normalizeCapability,
} from "@emdash-cms/plugin-types";

export { sha256Multihash } from "./multihash.js";
