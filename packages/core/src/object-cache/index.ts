/**
 * Object cache — distributed read-through query cache.
 *
 * Layering (per query):
 *
 *   requestCached   → in-request dedupe (per render, WeakMap on ALS context)
 *   cachedQuery     → THIS layer: distributed L2 (KV / memory), epoch-keyed
 *   database        → source of truth
 *
 * Optional and off by default: when no `objectCache` descriptor is configured,
 * `virtual:emdash/object-cache` exports `createObjectCache = undefined`,
 * {@link getBackend} resolves to `null`, and {@link cachedQuery} is a
 * transparent passthrough to its `load` function. Configure with
 * `memoryCache()` (Node) or `kvCache()` from `@emdash-cms/cloudflare`.
 *
 * Invalidation is epoch-based: each cache key embeds a per-namespace epoch
 * ("last changed" marker) read from the backend. A write calls
 * {@link invalidateObjectCache}, which stamps the namespace epoch to
 * `Date.now()`; every previously-stored key for that namespace is instantly
 * orphaned and reclaimed by its TTL. This is O(1) and needs no key
 * enumeration (KV has no prefix delete).
 *
 * The singleton backend/config and the per-isolate epoch cache live on
 * `globalThis` behind `Symbol.for` keys so Vite SSR chunk duplication can't
 * fork them (same pattern as `request-context.ts`).
 */

import { after } from "../after.js";
import { getRequestContext } from "../request-context.js";
import { decode, encode } from "./codec.js";
import type {
	CreateObjectCacheBackendFn,
	ObjectCacheBackend,
	ObjectCacheRuntimeConfig,
} from "./types.js";

const DEFAULT_KEY_PREFIX = "em";
const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_REVALIDATE_MS = 1000;

interface BackendHolder {
	/** Whether the virtual module has been loaded and the backend resolved. */
	initialized: boolean;
	/** Resolved backend, or `null` when no object cache is configured. */
	backend: ObjectCacheBackend | null;
	/** In-flight initialization promise (dedupes concurrent first calls). */
	initPromise: Promise<ObjectCacheBackend | null> | null;
	config: Required<Pick<ObjectCacheRuntimeConfig, "keyPrefix">> & {
		defaultTtl: number;
		revalidate: number;
	};
}

interface EpochEntry {
	value: number;
	/** `Date.now()` at which this epoch was read from the backend. */
	at: number;
	/** In-flight read, so concurrent callers share one backend round-trip. */
	promise?: Promise<number>;
}

const BACKEND_KEY = Symbol.for("emdash:object-cache:backend");
const EPOCH_KEY = Symbol.for("emdash:object-cache:epochs");
const PENDING_KEY = Symbol.for("emdash:object-cache:pending-bumps");
const g = globalThis as Record<symbol, unknown>;

const holder: BackendHolder =
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern (see request-context.ts)
	(g[BACKEND_KEY] as BackendHolder | undefined) ??
	(() => {
		const h: BackendHolder = {
			initialized: false,
			backend: null,
			initPromise: null,
			config: {
				keyPrefix: DEFAULT_KEY_PREFIX,
				defaultTtl: DEFAULT_TTL_SECONDS,
				revalidate: DEFAULT_REVALIDATE_MS,
			},
		};
		g[BACKEND_KEY] = h;
		return h;
	})();

const epochCache: Map<string, EpochEntry> =
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern (see request-context.ts)
	(g[EPOCH_KEY] as Map<string, EpochEntry> | undefined) ??
	(() => {
		const m = new Map<string, EpochEntry>();
		g[EPOCH_KEY] = m;
		return m;
	})();

/** Namespaces with a backend epoch write already scheduled this tick. */
const pendingBumps: Set<string> =
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern (see request-context.ts)
	(g[PENDING_KEY] as Set<string> | undefined) ??
	(() => {
		const s = new Set<string>();
		g[PENDING_KEY] = s;
		return s;
	})();

/**
 * Resolve (once per isolate) the configured object-cache backend.
 *
 * Loads `virtual:emdash/object-cache`, which exports `createObjectCache`
 * (`undefined` when no cache is configured) and the serialized
 * `objectCacheConfig`. Returns `null` when the cache is disabled.
 */
async function getBackend(): Promise<ObjectCacheBackend | null> {
	if (holder.initialized) return holder.backend;
	if (holder.initPromise) return holder.initPromise;

	holder.initPromise = (async () => {
		try {
			const mod: {
				createObjectCache?: CreateObjectCacheBackendFn;
				objectCacheConfig?: ObjectCacheRuntimeConfig;
				// eslint-disable-next-line @typescript-eslint/ban-ts-comment
				// @ts-ignore - virtual module
			} = await import("virtual:emdash/object-cache");

			const config = mod.objectCacheConfig ?? {};
			holder.config = {
				keyPrefix:
					typeof config.keyPrefix === "string" && config.keyPrefix.length > 0
						? config.keyPrefix
						: DEFAULT_KEY_PREFIX,
				defaultTtl:
					typeof config.defaultTtl === "number" && config.defaultTtl > 0
						? config.defaultTtl
						: DEFAULT_TTL_SECONDS,
				revalidate:
					typeof config.revalidate === "number" && config.revalidate >= 0
						? config.revalidate
						: DEFAULT_REVALIDATE_MS,
			};

			holder.backend =
				typeof mod.createObjectCache === "function" ? mod.createObjectCache(config) : null;
		} catch (error) {
			// Importing the virtual module fails outside an Astro/Vite context
			// (e.g. unit tests, CLI). Treat as "no cache configured".
			if (process.env["EMDASH_DEBUG_OBJECT_CACHE"]) {
				console.warn("[object-cache] backend unavailable:", error);
			}
			holder.backend = null;
		}
		holder.initialized = true;
		holder.initPromise = null;
		return holder.backend;
	})();

	return holder.initPromise;
}

/**
 * Test-only override of the backend, bypassing the virtual module.
 *
 * Lets unit tests inject an in-memory backend (and optional config) without a
 * full Astro/Vite build. Pass `null` to simulate "no cache configured".
 *
 * @internal
 */
export function __setObjectCacheBackendForTests(
	backend: ObjectCacheBackend | null,
	config?: Partial<BackendHolder["config"]>,
): void {
	holder.initialized = true;
	holder.initPromise = null;
	holder.backend = backend;
	holder.config = { ...holder.config, ...config };
	epochCache.clear();
}

/** Build the backend key for a namespace's epoch anchor. */
function epochKey(namespace: string): string {
	return `${holder.config.keyPrefix}:epoch:${namespace}`;
}

/** Build the backend key for a cached value within one or more namespaces. */
function valueKey(namespaces: readonly string[], epochs: readonly number[], key: string): string {
	const sig = namespaces.map((ns, i) => `${ns}@${epochs[i]}`).join(",");
	return `${holder.config.keyPrefix}:${sig}:${key}`;
}

/**
 * Requests that must always read live data and never populate the cache:
 * visual edit mode, preview tokens, and isolated databases (playground / DO
 * preview, whose schema and content diverge from the configured site).
 */
function shouldBypass(): boolean {
	const ctx = getRequestContext();
	if (!ctx) return false;
	return ctx.editMode === true || ctx.preview !== undefined || ctx.dbIsIsolated === true;
}

/**
 * Read the current epoch for `namespace`, reusing an isolate-cached value for
 * up to `revalidate` ms. A missing epoch (never bumped) is treated as `0`.
 *
 * Backend errors are non-fatal: we fall back to the last known epoch (or `0`),
 * so a flaky cache degrades to "serve whatever's keyed" rather than throwing.
 */
async function getEpoch(namespace: string, backend: ObjectCacheBackend): Promise<number> {
	const now = Date.now();
	const cached = epochCache.get(namespace);
	if (cached && now - cached.at < holder.config.revalidate) {
		return cached.value;
	}
	if (cached?.promise) return cached.promise;

	const promise = (async () => {
		try {
			const raw = await backend.get(epochKey(namespace));
			const parsed = raw === null ? 0 : Number(raw);
			const value = Number.isFinite(parsed) ? parsed : 0;
			epochCache.set(namespace, { value, at: Date.now() });
			return value;
		} catch {
			const fallback = cached?.value ?? 0;
			epochCache.set(namespace, { value: fallback, at: Date.now() });
			return fallback;
		}
	})();

	epochCache.set(namespace, { value: cached?.value ?? 0, at: cached?.at ?? 0, promise });
	return promise;
}

/** Options for {@link cachedQuery}. */
export interface CachedQueryOptions<T> {
	/**
	 * Invalidation namespace(s). A single string for self-contained data
	 * (`settings`, `menus`), or several when the cached value depends on data
	 * owned by other namespaces — e.g. a content entry hydrates bylines and
	 * taxonomy terms, so it caches under
	 * `[content:posts, "bylines", "taxonomies"]` and is invalidated when *any*
	 * of them is bumped. Every namespace's epoch is folded into the key.
	 */
	namespace: string | readonly string[];
	/** Stable, fully-qualifying cache key *within* the namespace. */
	key: string;
	/** Loader run on a miss (or when caching is disabled/bypassed). */
	load: () => Promise<T>;
	/** TTL override in seconds. Falls back to the configured `defaultTtl`. */
	ttl?: number;
	/**
	 * Predicate gating whether a freshly-loaded value is stored. Defaults to
	 * always-cache. Use it to skip caching error/empty sentinels.
	 */
	cacheable?: (value: T) => boolean;
}

/**
 * Distributed read-through cache around `load`.
 *
 * `T` must be the value as it should be *stored* — i.e. JSON-serializable with
 * the codec's `Date` support, carrying no functions or symbol-keyed props.
 * Callers caching richer objects (content entries) reduce to a serializable
 * snapshot here and rebuild on the way out; see `query.ts`.
 *
 * On a miss or when the cache is disabled/bypassed, this is equivalent to
 * `await load()`. Backend errors never propagate: a failing `get` is a miss, a
 * failing `set` is dropped.
 */
export async function cachedQuery<T>(options: CachedQueryOptions<T>): Promise<T> {
	const backend = await getBackend();
	if (!backend || shouldBypass()) {
		return options.load();
	}

	const namespaces =
		typeof options.namespace === "string" ? [options.namespace] : options.namespace;
	const epochs = await Promise.all(namespaces.map((ns) => getEpoch(ns, backend)));
	const fullKey = valueKey(namespaces, epochs, options.key);

	try {
		const raw = await backend.get(fullKey);
		if (raw !== null) {
			const decoded = decode(raw);
			if (decoded !== undefined) {
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- key namespacing guarantees the stored value matches T
				return decoded as T;
			}
		}
	} catch {
		// Treat backend read errors as a miss.
	}

	const value = await options.load();

	const cacheable = options.cacheable ? options.cacheable(value) : true;
	if (cacheable) {
		const raw = encode(value);
		const ttl = options.ttl ?? holder.config.defaultTtl;
		// Defer the write so it never adds to TTFB.
		after(async () => {
			try {
				await backend.set(fullKey, raw, ttl);
			} catch (error) {
				if (process.env["EMDASH_DEBUG_OBJECT_CACHE"]) {
					console.warn("[object-cache] set failed:", error);
				}
			}
		});
	}

	return value;
}

/**
 * Invalidate every cached value in `namespace` by bumping its epoch.
 *
 * Sync and non-blocking: the local epoch is stamped immediately (so the
 * writing isolate is instantly consistent) and the backend write is deferred
 * via `after`. Other isolates pick up the new epoch within their `revalidate`
 * window. No-ops when the cache is disabled.
 */
export function invalidateObjectCache(namespace: string): void {
	const stamp = Date.now();
	// Optimistic local bump: keep this isolate consistent without a round-trip.
	epochCache.set(namespace, { value: stamp, at: stamp });

	// Coalesce repeated bumps of the same namespace within a tick (e.g. a bulk
	// publish loop) into a single backend write that persists the latest epoch.
	if (pendingBumps.has(namespace)) return;
	pendingBumps.add(namespace);
	after(async () => {
		pendingBumps.delete(namespace);
		try {
			const backend = await getBackend();
			if (!backend) return;
			const latest = epochCache.get(namespace)?.value ?? stamp;
			// Epoch anchors are persistent (no TTL) — they must outlive the
			// value keys they invalidate.
			await backend.set(epochKey(namespace), String(latest));
		} catch (error) {
			console.error("[object-cache] epoch bump failed for", namespace, error);
		}
	});
}

/**
 * Fixed namespaces for data shared across collections. Content reads fold the
 * `BYLINES` and `TAXONOMIES` epochs into their keys (via {@link cachedQuery})
 * because entries hydrate byline and taxonomy-term data — so renaming an
 * author or a category correctly invalidates every cached entry that displays
 * it, without tracking which collections reference it.
 */
export const CacheNamespace = {
	SETTINGS: "settings",
	MENUS: "menus",
	TAXONOMIES: "taxonomies",
	BYLINES: "bylines",
} as const;

/** Namespace for a content collection's cached queries. */
export function contentNamespace(collection: string): string {
	return `content:${collection}`;
}

/**
 * Namespaces a content read depends on: the collection itself plus the shared
 * byline/taxonomy data folded into each entry.
 */
export function contentNamespaces(collection: string): readonly string[] {
	return [contentNamespace(collection), CacheNamespace.BYLINES, CacheNamespace.TAXONOMIES];
}

/**
 * Invalidate all cached reads (list + entry) for a content collection.
 * Call from every write path that mutates rows in `ec_<collection>`.
 */
export function invalidateCollectionCache(collection: string): void {
	invalidateObjectCache(contentNamespace(collection));
}

/** Invalidate cached taxonomy definitions/terms and all content that hydrates them. */
export function invalidateTaxonomyObjectCache(): void {
	invalidateObjectCache(CacheNamespace.TAXONOMIES);
}

/** Invalidate cached bylines and all content that hydrates them. */
export function invalidateBylineObjectCache(): void {
	invalidateObjectCache(CacheNamespace.BYLINES);
}

/** Invalidate cached navigation menus. */
export function invalidateMenuObjectCache(): void {
	invalidateObjectCache(CacheNamespace.MENUS);
}

export type {
	ObjectCacheBackend,
	ObjectCacheDescriptor,
	ObjectCacheRuntimeConfig,
} from "./types.js";
