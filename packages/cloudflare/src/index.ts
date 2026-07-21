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

import type {
	AuthDescriptor,
	DatabaseDescriptor,
	ObjectCacheDescriptor,
	StorageDescriptor,
} from "emdash";

import type { DurableObjectsConfig } from "./db/do-sql-types.js";
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
	 *
	 * **Warning:** incompatible with the `global_fetch_strictly_public`
	 * compatibility flag. With that flag set, the internal request the D1
	 * Sessions API makes to route queries to replicas is silently blocked
	 * and every SSR request hangs until the Worker is killed — with no
	 * error logged (`outcome: "canceled"`, empty `exceptions`). The hang
	 * may only start once replicas finish provisioning, so it can pass an
	 * initial post-deploy check. Remove the flag or keep sessions
	 * disabled. See https://github.com/emdash-cms/emdash/issues/1273.
	 */
	session?: "disabled" | "auto" | "primary-first";

	/**
	 * Cookie name for storing the session bookmark.
	 * Only used when session is `"auto"` or `"primary-first"`.
	 *
	 * @default "__em_d1_bookmark"
	 */
	bookmarkCookie?: string;

	/**
	 * Experimental: batch concurrent read queries into one D1 round trip.
	 *
	 * SELECT queries issued in the same event-loop turn are buffered and
	 * executed as a single D1 `batch()` call (one HTTP round trip) instead
	 * of N serialized round trips. Writes, CTEs and other statements are not
	 * batched — they enqueue immediately on the direct path. If the batch
	 * fails, queries are retried individually so each query keeps its own
	 * error semantics. Every physical D1 call (writes and the SELECT batch
	 * alike) is serialized per request, so the session bookmark always
	 * advances in execution order.
	 *
	 * Only applies to the per-request session database, so `session` must
	 * also be enabled (`"auto"` or `"primary-first"`); the shared singleton
	 * never coalesces.
	 *
	 * Ordering caveat: buffered reads execute at the next flush window
	 * (~one macrotask later), while a write enqueues immediately. A read and
	 * a write issued concurrently in the same turn (e.g. under
	 * `Promise.all`) may therefore execute write-first (they never overlap).
	 * Reads that must observe pre-write state should be awaited before
	 * issuing the write — which sequential `await` code already does.
	 *
	 * @default false
	 */
	coalesce?: boolean;
}

/**
 * Hyperdrive configuration
 */
export interface HyperdriveConfig {
	/**
	 * Name of the Hyperdrive binding in wrangler config. This is the primary,
	 * **caching-disabled** binding — every authenticated request and every write
	 * uses it, so read-after-write consistency holds.
	 * @default "HYPERDRIVE"
	 */
	binding?: string;

	/**
	 * Optional name of a second Hyperdrive binding pointing at a
	 * **caching-enabled** configuration over the *same* database.
	 *
	 * When set, anonymous reads of **public-site paths** (no session, GET/HEAD,
	 * not under `/_emdash`) route through this cache-enabled binding for lower
	 * latency and reduced database load. Everything else stays on `binding`
	 * (uncached) to preserve read-after-write consistency: every authenticated
	 * request, every write, and every request under `/_emdash` (admin, setup,
	 * auth, internal APIs) — including anonymous GETs like the post-setup status
	 * check, which must observe a write made moments earlier. Migrations and the
	 * cold-start singleton always use `binding`.
	 *
	 * Anonymous reads of just-published content can be up to the cache's
	 * `max_age` stale (Hyperdrive default 60s, max 1h), and this cache is
	 * independent of EmDash's own cache invalidation — only opt in if a short
	 * public-read staleness window is acceptable. Omit it and the adapter uses
	 * the single primary binding as before.
	 *
	 * Bind both configs in wrangler:
	 * ```jsonc
	 * {
	 *   "hyperdrive": [
	 *     { "binding": "HYPERDRIVE", "id": "<caching-disabled-id>" },
	 *     { "binding": "HYPERDRIVE_CACHED", "id": "<caching-enabled-id>" }
	 *   ]
	 * }
	 * ```
	 */
	cachedBinding?: string;

	/**
	 * Maximum size of the in-Worker node-postgres connection pool.
	 *
	 * Hyperdrive maintains the real connection pool to your origin database,
	 * so this only caps connections from the Worker isolate to Hyperdrive.
	 * Keep it low to stay within Workers' concurrent external connection
	 * limits.
	 *
	 * @default 5
	 */
	max?: number;
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
		supportsCoalescing: true,
	};
}

/**
 * Cloudflare Hyperdrive database adapter (PostgreSQL)
 *
 * For Cloudflare Workers connecting to an existing PostgreSQL or
 * PostgreSQL-compatible database (e.g. PlanetScale Postgres) through a
 * Hyperdrive binding. Hyperdrive pools and accelerates the connection;
 * EmDash's PostgreSQL dialect runs the queries.
 *
 * Each request gets its own pooled connection that is opened and closed within
 * that request — Worker connections cannot be reused across requests.
 *
 * Requires in the consuming site:
 * - `pg >= 8.16.3` installed
 * - `compatibility_flags: ["nodejs_compat"]`
 * - `compatibility_date >= "2024-09-23"`
 * - A Hyperdrive binding in wrangler config:
 *   ```jsonc
 *   { "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<id>" }] }
 *   ```
 *
 * **Disable Hyperdrive query caching for this configuration.** EmDash runs its
 * own caching layer and depends on read-after-write consistency — the admin and
 * setup wizard write a row and immediately read it back. Hyperdrive's default-on
 * query cache can serve the pre-write result within its TTL, which corrupts
 * setup (e.g. "collection already exists" / missing columns) and shows editors
 * stale content. Turn it off when creating the config:
 * ```sh
 * wrangler hyperdrive update <id> --caching-disabled
 * # or, at create time: wrangler hyperdrive create ... --caching-disabled
 * ```
 *
 * **Optional: serve anonymous reads from cache.** If a short public-read
 * staleness window is acceptable, pass a second `cachedBinding` pointing at a
 * caching-enabled Hyperdrive config over the same database. Anonymous read
 * requests then route through the cache-enabled binding while authenticated
 * requests and writes stay on the uncached `binding`, keeping read-after-write
 * consistency intact:
 * ```ts
 * database: hyperdrive({ binding: "HYPERDRIVE", cachedBinding: "HYPERDRIVE_CACHED" })
 * ```
 *
 * For best latency, pair this with a Smart Placement hint so the Worker runs in
 * the Cloudflare data center closest to your database's region — the request
 * path makes multiple round trips, so co-locating the Worker with the origin
 * matters:
 * ```jsonc
 * { "placement": { "region": "aws:us-east-1" } }
 * ```
 *
 * Each request gets its own pg connection, and the Cron Trigger sweep, plugin
 * hook contexts, and media providers resolve an event-scoped connection too, so
 * the content read/write path, scheduled publishing, plugin cron, and
 * DB-querying plugin hooks are all supported.
 *
 * **Known limitation — sandboxed plugins are D1-only.** The sandbox plugin
 * bridge talks to a D1 binding directly (independent of the configured
 * adapter), so sandboxed plugins aren't available on a Hyperdrive deployment.
 * This is a pre-existing bridge constraint, unrelated to connection scoping;
 * tracked in https://github.com/emdash-cms/emdash/issues/1623.
 *
 * @example
 * ```ts
 * database: hyperdrive({ binding: "HYPERDRIVE" })
 * ```
 */
export function hyperdrive(config: HyperdriveConfig = {}): DatabaseDescriptor {
	return {
		entrypoint: "@emdash-cms/cloudflare/db/hyperdrive",
		config: {
			binding: config.binding ?? "HYPERDRIVE",
			max: config.max,
			...(config.cachedBinding !== undefined ? { cachedBinding: config.cachedBinding } : {}),
		},
		type: "postgres",
		// Each request gets a fresh pg connection that is closed afterwards —
		// connections cannot be reused across Worker requests.
		supportsRequestScope: true,
	};
}

export type { PreviewDOConfig } from "./db/do-types.js";
export type { DurableObjectsConfig } from "./db/do-sql-types.js";

/**
 * Durable Object SQL database adapter (production)
 *
 * Stores the whole CMS in a single Durable Object's SQLite. With
 * `session: "auto"` and the `experimental` + `replica_routing` compatibility
 * flags, reads route to the nearest replica and writes proxy to the primary,
 * cutting read round-trip latency versus a single-region primary.
 *
 * Requires the `EmDashDB` class to be registered in your worker entry and a
 * `new_sqlite_classes` migration in wrangler.
 *
 * @example
 * ```ts
 * database: durableObjects({ binding: "DB_DO", session: "auto" })
 * ```
 */
export function durableObjects(config: DurableObjectsConfig): DatabaseDescriptor {
	return {
		entrypoint: "@emdash-cms/cloudflare/db/do-sql",
		config,
		type: "sqlite",
		supportsRequestScope: true,
		supportsCoalescing: true,
	};
}

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

/**
 * Cloudflare KV object-cache configuration.
 */
export interface KVCacheConfig {
	/** Name of the KV binding in wrangler.jsonc. */
	binding: string;
	/**
	 * Default TTL for cached entries, in seconds. Backstop for epoch-orphaned
	 * keys (KV clamps to a 60s minimum). Default 3600.
	 */
	defaultTtl?: number;
	/**
	 * Cross-isolate staleness window in milliseconds: how long an isolate
	 * reuses a cached namespace epoch before re-reading it. Default 1000.
	 */
	revalidate?: number;
	/**
	 * Maximum time (ms) for a single KV operation before it's treated as a
	 * cache miss. Guards against KV reads that stall without settling. Set to
	 * `0` to disable. Default 2000.
	 */
	timeout?: number;
	/** Prefix applied to every cache key (lets multiple sites share a namespace). */
	keyPrefix?: string;
}

/**
 * Cloudflare KV object-cache adapter.
 *
 * Backs EmDash's optional distributed object cache with a Workers KV
 * namespace, offloading content and chrome reads from D1. Requires a KV
 * binding in wrangler.jsonc.
 *
 * @example
 * ```ts
 * import { d1, kvCache } from "@emdash-cms/cloudflare";
 *
 * emdash({
 *   database: d1({ binding: "DB" }),
 *   objectCache: kvCache({ binding: "CACHE" }),
 * })
 * ```
 *
 * ```jsonc
 * // wrangler.jsonc
 * { "kv_namespaces": [{ "binding": "CACHE", "id": "<namespace-id>" }] }
 * ```
 */
export function kvCache(config: KVCacheConfig): ObjectCacheDescriptor {
	return {
		entrypoint: "@emdash-cms/cloudflare/cache/kv",
		config: {
			binding: config.binding,
			...(config.defaultTtl !== undefined ? { defaultTtl: config.defaultTtl } : {}),
			...(config.revalidate !== undefined ? { revalidate: config.revalidate } : {}),
			...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
			...(config.keyPrefix !== undefined ? { keyPrefix: config.keyPrefix } : {}),
		},
	};
}

// Re-export media providers (config-time)
export { cloudflareImages, type CloudflareImagesConfig } from "./media/images.js";
export { cloudflareStream, type CloudflareStreamConfig } from "./media/stream.js";

// Re-export cache provider config helper (config-time)
export { cloudflareCache, type CloudflareCacheConfig } from "./cache/config.js";
