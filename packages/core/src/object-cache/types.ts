/**
 * Object cache types
 *
 * The object cache is an optional, distributed read-through cache that sits
 * *beneath* the per-request cache (`requestCached`) and *above* the database.
 * Query results (content entries, settings, menus, taxonomies) are stored in a
 * fast key/value store (Cloudflare KV, or an in-isolate memory store for Node)
 * so repeat reads across requests and isolates skip the database entirely.
 *
 * Backends only ever deal in strings — serialization (including `Date`
 * preservation) is handled by the core read-through layer in `./codec.ts`, so
 * every backend behaves identically.
 */

/**
 * A pluggable object-cache backend.
 *
 * Implementations must be safe to call concurrently and should never throw on
 * cache misses — `get` returns `null` for a miss. A backend that throws (e.g.
 * a transient KV error) degrades gracefully: the read-through layer treats a
 * thrown `get` as a miss and a thrown `set` as a no-op, so the database
 * remains the source of truth.
 */
export interface ObjectCacheBackend {
	/** Return the stored string for `key`, or `null` on a miss. */
	get(key: string): Promise<string | null>;
	/**
	 * Store `value` under `key`.
	 *
	 * @param ttlSeconds Optional time-to-live in seconds. Backends that don't
	 *   support TTLs may ignore it, but distributed backends (KV) should honor
	 *   it so orphaned, epoch-busted keys are eventually reclaimed.
	 */
	set(key: string, value: string, ttlSeconds?: number): Promise<void>;
	/** Remove `key`. Idempotent — deleting a missing key is not an error. */
	delete(key: string): Promise<void>;
}

/**
 * Serializable descriptor for an object-cache backend.
 *
 * Mirrors {@link import("../storage/types.js").StorageDescriptor}: `entrypoint`
 * is a module specifier resolved at build time that exports a
 * {@link CreateObjectCacheBackendFn} named `createObjectCache`; `config` is the
 * plain, serializable runtime config passed to it.
 */
export interface ObjectCacheDescriptor {
	/** Module path exporting a `createObjectCache` function. */
	entrypoint: string;
	/** Serializable config passed to `createObjectCache` at runtime. */
	config: ObjectCacheRuntimeConfig;
}

/**
 * Runtime config shared by every backend, plus backend-specific keys.
 *
 * The read-through layer reads `defaultTtl`, `revalidate`, and `keyPrefix`;
 * individual backends read their own keys (e.g. the KV backend reads
 * `binding`).
 */
export interface ObjectCacheRuntimeConfig {
	/**
	 * Default time-to-live for cached entries, in seconds.
	 *
	 * Invalidation works by epoch comparison, not key deletion: a stale value
	 * is detected on read (its stored epoch no longer matches) and overwritten
	 * in place under the same key. The TTL is just a backstop that reclaims
	 * keys that are never read again.
	 *
	 * @default 3600 (1 hour)
	 */
	defaultTtl?: number;
	/**
	 * How long (milliseconds) an isolate may reuse a cached namespace epoch
	 * before re-reading it from the backend.
	 *
	 * This is the cross-isolate staleness window: after a write bumps a
	 * namespace's epoch, other isolates keep serving the previous epoch's keys
	 * until their cached epoch expires. Authenticated/preview/edit requests
	 * bypass the cache entirely, so editors always see fresh content; this
	 * window only affects anonymous visitors.
	 *
	 * Set to `0` to re-read the epoch on every query (strongest freshness, more
	 * backend reads).
	 *
	 * @default 1000
	 */
	revalidate?: number;
	/**
	 * Prefix applied to every cache key. Lets multiple EmDash sites share one
	 * KV namespace without colliding.
	 *
	 * @default "em"
	 */
	keyPrefix?: string;
	/**
	 * Maximum time (milliseconds) to wait for a single backend read before
	 * treating it as a cache miss and falling back to the database.
	 *
	 * Guards against a backend operation that stalls without resolving or
	 * rejecting (e.g. a cold cross-region KV read, or one queued behind the
	 * Workers simultaneous-connection limit), which would otherwise hang the
	 * request. A timed-out read degrades to a miss; the database remains the
	 * source of truth.
	 *
	 * Set to `0` to disable the timeout (not recommended on Cloudflare).
	 *
	 * @default 2000
	 */
	timeout?: number;
	/** Backend-specific keys (e.g. the KV binding name). */
	[key: string]: unknown;
}

/**
 * Factory signature exported as `createObjectCache` from a backend entrypoint.
 *
 * Each backend accesses its own resources directly: the KV backend imports
 * bindings from `cloudflare:workers`; the memory backend uses an in-isolate
 * map.
 */
export type CreateObjectCacheBackendFn = (config: ObjectCacheRuntimeConfig) => ObjectCacheBackend;
