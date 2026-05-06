/**
 * @emdash-cms/plugin-types
 *
 * Shared TypeScript types for the EmDash plugin manifest contract.
 *
 * Two packages need to agree on this shape:
 *
 *   - **`emdash` (core)** reads `manifest.json` at install time and again at
 *     runtime when gating a sandboxed plugin's access to capabilities. Core
 *     is the contract reader.
 *   - **`@emdash-cms/registry-cli`** writes `manifest.json` during bundling
 *     (extracted from the plugin author's source) and publishes the resulting
 *     records via atproto. registry-cli is the contract writer.
 *
 * Anything that has to round-trip cleanly between writer and reader belongs
 * here: the capability vocabulary, the manifest shape, the hook/route entry
 * types, and the legacy-name rename map.
 *
 * Things that don't belong here:
 *
 *   - `ResolvedPlugin` and the rest of core's runtime plugin types — those
 *     are core-internal shapes for in-memory plugin instances and pull in
 *     a lot of Astro / blocks / schema dependencies.
 *   - The `@atcute/*` lexicon types for the registry's atproto records.
 *     Those live in `@emdash-cms/registry-lexicons` since they describe a
 *     different contract layer.
 *
 * EXPERIMENTAL: this package is published as part of the experimental plugin
 * registry roll-out. Pin to an exact version while RFC 0001 is in flight;
 * the manifest shape may evolve before the registry phase 1 cutover.
 */

// ── Plugin capability vocabulary ─────────────────────────────────────────────

/**
 * The full set of capability strings the bundler and the runtime understand,
 * including the deprecated legacy aliases. New plugins should use only the
 * canonical names; the legacy ones are kept in the union so old code
 * typechecks during the deprecation window.
 *
 * The runtime alias layer (`normalizeCapability`) maps legacy names to
 * canonical ones at every external boundary.
 */
export type PluginCapability =
	// Network
	| "network:request" // ctx.http (host-restricted via allowedHosts)
	| "network:request:unrestricted" // ctx.http (unrestricted)
	// Content
	| "content:read"
	| "content:write"
	// Media
	| "media:read"
	| "media:write"
	// Users
	| "users:read"
	// Email
	| "email:send"
	// Hook registration
	| "hooks.email-transport:register" // exclusive `email:deliver` (transport)
	| "hooks.email-events:register" // `email:beforeSend` / `email:afterSend`
	| "hooks.page-fragments:register" // `page:fragments` (script/style injection)
	// Deprecated aliases (kept for the deprecation window; warnings emitted at
	// bundle time, hard fail at publish time).
	| "network:fetch"
	| "network:fetch:any"
	| "read:content"
	| "write:content"
	| "read:media"
	| "write:media"
	| "read:users"
	| "email:provide"
	| "email:intercept"
	| "page:inject";

/**
 * Deprecated capability names that map to current names.
 *
 * Accepted at every external boundary (manifest parse, definePlugin, sandbox
 * adapter) and silently normalized to the new names before reaching the
 * runtime. Authors are warned at `bundle` / `validate`, hard-failed at
 * `publish`.
 */
export type DeprecatedPluginCapability =
	| "network:fetch"
	| "network:fetch:any"
	| "read:content"
	| "write:content"
	| "read:media"
	| "write:media"
	| "read:users"
	| "email:provide"
	| "email:intercept"
	| "page:inject";

/** Current (non-deprecated) capability names. */
export type CurrentPluginCapability = Exclude<PluginCapability, DeprecatedPluginCapability>;

/**
 * Mapping from deprecated capability names to their current replacements.
 *
 * Used to compare manifests across the rename without flagging spurious
 * "capability changed" prompts on upgrade, and to produce the warning
 * messages at bundle time.
 */
export const CAPABILITY_RENAMES: Readonly<
	Record<DeprecatedPluginCapability, CurrentPluginCapability>
> = Object.freeze({
	"network:fetch": "network:request",
	"network:fetch:any": "network:request:unrestricted",
	"read:content": "content:read",
	"write:content": "content:write",
	"read:media": "media:read",
	"write:media": "media:write",
	"read:users": "users:read",
	"email:provide": "hooks.email-transport:register",
	"email:intercept": "hooks.email-events:register",
	"page:inject": "hooks.page-fragments:register",
});

/**
 * Type guard: is this capability one of the deprecated legacy names?
 *
 * Uses an own-property check so prototype keys like "toString" don't
 * accidentally pass.
 */
export function isDeprecatedCapability(cap: string): cap is DeprecatedPluginCapability {
	return Object.hasOwn(CAPABILITY_RENAMES, cap);
}

/**
 * Normalize a capability string -- deprecated names map to current names,
 * current names pass through unchanged. Unknown strings are returned as-is
 * so downstream validators can produce a precise error.
 */
export function normalizeCapability(cap: string): string {
	if (isDeprecatedCapability(cap)) {
		return CAPABILITY_RENAMES[cap];
	}
	return cap;
}

/**
 * Normalize an array of capability strings, preserving order and removing
 * duplicates introduced by aliasing (e.g. a manifest declaring both
 * `network:fetch` and `network:request` should resolve to a single
 * `network:request`).
 */
export function normalizeCapabilities(caps: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const cap of caps) {
		const norm = normalizeCapability(cap);
		if (!seen.has(norm)) {
			seen.add(norm);
			out.push(norm);
		}
	}
	return out;
}

// ── Manifest shape ───────────────────────────────────────────────────────────

/**
 * Hook entry in a plugin manifest. Either a plain hook name (when the hook
 * has default priority/timeout/exclusivity) or a structured object that
 * carries the metadata.
 *
 * Authors don't write these directly -- they write `definePlugin({ hooks })`
 * or a descriptor `{ hooks }` object, and the bundler emits the right shape.
 */
export interface ManifestHookEntry {
	name: string;
	exclusive?: boolean;
	priority?: number;
	timeout?: number;
}

/**
 * Route entry in a plugin manifest. Either a plain route name or a structured
 * entry with the `public` flag set.
 */
export interface ManifestRouteEntry {
	name: string;
	public?: boolean;
}

/**
 * Per-collection storage config in a plugin manifest.
 *
 * Each collection declares the indexes the host should create. Single-string
 * entries index a single field; nested arrays request composite indexes
 * (multi-column). `uniqueIndexes` carries the same shape but with a UNIQUE
 * constraint -- those entries are already queryable, no need to duplicate
 * them in `indexes`.
 *
 * Core has a stricter `StorageCollectionConfig` interface for runtime use;
 * this is the manifest-wire shape both sides agree on.
 */
export interface StorageCollectionConfig {
	/**
	 * Indexes to create. Each entry is either a single field name or an
	 * array of field names for a composite index.
	 */
	indexes: Array<string | string[]>;
	/**
	 * Fields with unique constraints. Same shape as `indexes`. Unique
	 * indexes are also queryable, so don't duplicate them in `indexes`.
	 */
	uniqueIndexes?: Array<string | string[]>;
}

/**
 * Plugin storage declaration. Maps a collection name to its index config.
 */
export type PluginStorageConfig = Record<string, StorageCollectionConfig>;

/**
 * Plugin admin surface in the manifest. Sandboxed plugins MUST NOT set the
 * `entry` field (that requires native/trusted mode); the bundler validates
 * its absence.
 */
export interface PluginAdminConfig {
	/** Settings form schema (Zod or JSON Schema; runtime parses). */
	settingsSchema?: unknown;
	/** Admin pages declared by the plugin (rendered via Block Kit). */
	pages?: Array<unknown>;
	/** Dashboard widgets declared by the plugin. */
	widgets?: Array<unknown>;
	/**
	 * Native-only: a module specifier for a React entry. Sandboxed plugins
	 * MUST NOT set this; the bundler validates the absence and the publish
	 * flow refuses records that include it.
	 */
	entry?: string;
	/**
	 * Native-only: trusted-mode portable text blocks. Bundler errors if a
	 * sandboxed plugin declares any.
	 */
	portableTextBlocks?: Array<unknown>;
}

/**
 * The serialised manifest written to `manifest.json` inside a plugin tarball,
 * and read by the host at install/runtime. The wire contract.
 *
 * Both the bundler (writer) and the runtime (reader) MUST agree on this
 * shape; that's why it lives in this shared package rather than either side.
 */
export interface PluginManifest {
	id: string;
	version: string;
	capabilities: PluginCapability[];
	allowedHosts: string[];
	storage: PluginStorageConfig;
	/**
	 * Hook declarations -- plain name strings (when the hook has default
	 * priority/timeout/exclusivity) or structured `ManifestHookEntry` objects
	 * with explicit metadata. Hook names are opaque strings at this layer;
	 * core has an exhaustive union of recognised hook names internally.
	 */
	hooks: Array<ManifestHookEntry | string>;
	/** Route declarations -- plain name strings or structured objects. */
	routes: Array<ManifestRouteEntry | string>;
	admin: PluginAdminConfig;
}

// ── Slug / version helpers ───────────────────────────────────────────────────

const SLASH_RE = /\//g;
const LEADING_AT_RE = /^@/;

/**
 * Slug constraint per the registry lexicon: ASCII lowercase letter, then
 * lowercase letters / digits / hyphen / underscore, max 64 chars. The lexicon
 * description spells it out; the JSON itself only enforces minLength/maxLength
 * so we add the regex check here.
 */
export const PLUGIN_SLUG_RE = /^[a-z][a-z0-9_-]*$/;
export const PLUGIN_SLUG_MAX_LENGTH = 64;

/**
 * Version constraint per the registry lexicon: a subset of semver 2.0 with
 * the build-metadata suffix (`+...`) explicitly disallowed (atproto record
 * keys can't contain `+`), and the version composed only of characters
 * allowed in atproto record keys.
 *
 * The shape mirrors the official semver 2.0 BNF:
 *
 *   <major>.<minor>.<patch>[-<pre-release>]
 *
 * where each numeric component has no leading zeros (except the literal
 * `0`), and the optional pre-release is `.`-separated identifiers, each
 * being either a numeric (no leading zeros) or alphanumeric-with-hyphens
 * (must include a non-digit if it has hyphens).
 *
 * If you want to accept build metadata, this is the wrong type -- the
 * registry rejects it because the atproto rkey alphabet doesn't include
 * `+`. Build metadata is "ignored when comparing versions" per semver
 * anyway, so dropping it before publish is fine.
 */
export const PLUGIN_VERSION_RE =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;
export const PLUGIN_VERSION_MAX_LENGTH = 64;

/**
 * Convert a plugin id (which may be a scoped npm name like
 * `@emdash-cms/sandboxed-test`) into a candidate slug suitable for use as an
 * atproto rkey. Strips a leading `@` and replaces `/` with `-`. The result
 * still needs `isPluginSlug()` validation -- callers should fail fast if
 * the manifest's id is malformed rather than relying on the PDS to reject.
 */
export function deriveSlugFromId(id: string): string {
	return id.replace(LEADING_AT_RE, "").replace(SLASH_RE, "-");
}

export function isPluginSlug(value: string): boolean {
	return value.length > 0 && value.length <= PLUGIN_SLUG_MAX_LENGTH && PLUGIN_SLUG_RE.test(value);
}

export function isPluginVersion(value: string): boolean {
	return (
		value.length > 0 && value.length <= PLUGIN_VERSION_MAX_LENGTH && PLUGIN_VERSION_RE.test(value)
	);
}
