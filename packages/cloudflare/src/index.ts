/**
 * @emdash-cms/cloudflare
 *
 * Cloudflare adapters for EmDash:
 * - D1 database adapter
 * - R2 storage adapter
 * - Cloudflare Access authentication
 * - Worker Loader sandbox for plugins
 *
 * This is the CONFIG-TIME entry point. It does NOT import cloudflare:workers
 * and is safe to use in astro.config.mjs.
 *
 * For runtime exports (PluginBridge, authenticate), import from the specific
 * runtime entrypoints:
 * - @emdash-cms/cloudflare/sandbox (PluginBridge, createSandboxRunner)
 * - @emdash-cms/cloudflare/auth (authenticate)
 *
 * @example
 * ```ts
 * import emdash from "emdash/astro";
 * import { d1, r2, access, sandbox } from "@emdash-cms/cloudflare";
 *
 * export default defineConfig({
 *   integrations: [
 *     emdash({
 *       database: d1({ binding: "DB" }),
 *       storage: r2({ binding: "MEDIA" }),
 *       auth: access({ teamDomain: "myteam.cloudflareaccess.com" }),
 *       sandboxRunner: sandbox(),
 *     }),
 *   ],
 * });
 * ```
 */

import type { AuthDescriptor, DatabaseDescriptor, StorageDescriptor } from "emdash";

import type { PreviewDOConfig } from "./db/do-types.js";

/**
 * D1 configuration
 */
export interface D1Config {
	/**
	 * Name of the D1 binding in wrangler.toml
	 */
	binding: string;

	/**
	 * Read replication session mode.
	 *
	 * - `"disabled"` — No sessions. All queries go to primary. (default)
	 * - `"auto"` — Automatic session management. Anonymous requests use
	 *   `"first-unconstrained"` (nearest replica). Authenticated requests
	 *   use bookmark cookies for read-your-writes consistency.
	 * - `"primary-first"` — Like `"auto"`, but the first query in every
	 *   session goes to the primary. Use this if your site has very
	 *   frequent writes and you need stronger consistency guarantees
	 *   at the cost of higher read latency.
	 *
	 * Read replication must also be enabled on the D1 database itself
	 * (via dashboard or REST API).
	 */
	session?: "disabled" | "auto" | "primary-first";

	/**
	 * Cookie name for storing the session bookmark.
	 * Only used when session is `"auto"` or `"primary-first"`.
	 *
	 * @default "__em_d1_bookmark"
	 */
	bookmarkCookie?: string;
}

/**
 * R2 storage configuration
 */
export interface R2StorageConfig {
	/**
	 * Name of the R2 binding in wrangler.toml
	 */
	binding: string;
	/**
	 * Public URL for accessing files (optional CDN)
	 */
	publicUrl?: string;
}

/**
 * Configuration for Cloudflare Access authentication
 */
export interface AccessConfig {
	/**
	 * Your Cloudflare Access team domain
	 * @example "myteam.cloudflareaccess.com"
	 */
	teamDomain: string;

	/**
	 * Application Audience (AUD) tag from Access application settings.
	 * For Cloudflare Workers, use `audienceEnvVar` instead to read at runtime.
	 */
	audience?: string;

	/**
	 * Environment variable name containing the audience tag.
	 * Read at runtime from environment.
	 * @default "CF_ACCESS_AUDIENCE"
	 */
	audienceEnvVar?: string;

	/**
	 * Automatically create EmDash users on first login
	 * @default true
	 */
	autoProvision?: boolean;

	/**
	 * Role level for users not matching any group in roleMapping
	 * @default 30 (Editor)
	 */
	defaultRole?: number;

	/**
	 * Update user's role on each login based on current IdP groups
	 * When false, role is only set on first provisioning
	 * @default false
	 */
	syncRoles?: boolean;

	/**
	 * Map IdP group names to EmDash role levels
	 * First match wins if user is in multiple groups
	 *
	 * @example
	 * ```ts
	 * roleMapping: {
	 *   "Admins": 50,        // Admin
	 *   "Developers": 40,    // Developer
	 *   "Content Team": 30,  // Editor
	 * }
	 * ```
	 */
	roleMapping?: Record<string, number>;
}

/**
 * Cloudflare D1 database adapter
 *
 * For Cloudflare Workers with D1 binding.
 * Migrations run automatically at setup time - no need for manual SQL files.
 *
 * Uses a custom introspector that works around D1's restriction on
 * cross-joins with pragma_table_info().
 *
 * @example
 * ```ts
 * database: d1({ binding: "DB" })
 * ```
 */
export function d1(config: D1Config): DatabaseDescriptor {
	return {
		entrypoint: "@emdash-cms/cloudflare/db/d1",
		config,
		type: "sqlite",
		supportsRequestScope: true,
	};
}

export type { PreviewDOConfig } from "./db/do-types.js";

/**
 * Durable Object preview database adapter
 *
 * Each preview session gets an isolated SQLite database inside a DO,
 * populated from a snapshot of the source EmDash site.
 *
 * Not for production use — preview only.
 *
 * @example
 * ```ts
 * database: previewDatabase({ binding: "PREVIEW_DB" })
 * ```
 */
export function previewDatabase(config: PreviewDOConfig): DatabaseDescriptor {
	return {
		entrypoint: "@emdash-cms/cloudflare/db/do",
		config,
		type: "sqlite",
	};
}

/**
 * Durable Object playground database adapter
 *
 * Each playground session gets an isolated SQLite database inside a DO,
 * populated from a seed file with migrations run at init time.
 * Unlike preview, playground is writable and has admin access.
 *
 * Not for production use -- playground/demo only.
 *
 * @example
 * ```ts
 * database: playgroundDatabase({ binding: "PLAYGROUND_DB" })
 * ```
 */
export function playgroundDatabase(config: PreviewDOConfig): DatabaseDescriptor {
	return {
		entrypoint: "@emdash-cms/cloudflare/db/playground",
		config,
		type: "sqlite",
	};
}

/**
 * Cloudflare R2 binding adapter
 *
 * Uses R2 bindings directly when running on Cloudflare Workers.
 * Does NOT support signed upload URLs (use s3() with R2 credentials instead).
 *
 * Requires R2 binding in wrangler.toml:
 * ```toml
 * [[r2_buckets]]
 * binding = "MEDIA"
 * bucket_name = "my-media-bucket"
 * ```
 *
 * @example
 * ```ts
 * storage: r2({ binding: "MEDIA" })
 * ```
 */
export function r2(config: R2StorageConfig): StorageDescriptor {
	return {
		entrypoint: "@emdash-cms/cloudflare/storage/r2",
		config: { binding: config.binding, publicUrl: config.publicUrl },
	};
}

/**
 * Cloudflare Access authentication adapter
 *
 * Use this to configure EmDash to authenticate via Cloudflare Access.
 * When Access is configured, passkey auth is disabled.
 *
 * @example
 * ```ts
 * auth: access({
 *   teamDomain: "myteam.cloudflareaccess.com",
 *   audience: "abc123...",
 *   roleMapping: {
 *     "Admins": 50,
 *     "Editors": 30,
 *   },
 * })
 * ```
 */
export function access(config: AccessConfig): AuthDescriptor {
	return {
		type: "cloudflare-access",
		entrypoint: "@emdash-cms/cloudflare/auth",
		config,
	};
}

/**
 * Cloudflare Worker Loader sandbox adapter
 *
 * Returns the module path for the Cloudflare sandbox runner.
 * Use this in the `sandboxRunner` config option.
 *
 * @example
 * ```ts
 * sandboxRunner: sandbox()
 * ```
 */
export function sandbox(): string {
	return "@emdash-cms/cloudflare/sandbox";
}

// Re-export media providers (config-time)
export { cloudflareImages, type CloudflareImagesConfig } from "./media/images.js";
export { cloudflareStream, type CloudflareStreamConfig } from "./media/stream.js";

// Re-export cache provider config helper (config-time)
export { cloudflareCache, type CloudflareCacheConfig } from "./cache/config.js";
