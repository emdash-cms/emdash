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
const DEFAULT_TIMEOUT_MS = 2000;

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
		timeout: number;
	};
}

/**
 * Race a backend operation against a timeout so a stalled call (e.g. a KV read
 * that never resolves *and* never rejects — a cold cross-region read, or one
 * queued behind the Workers simultaneous-connection limit) degrades to a
 * rejection instead of hanging the isolate. A rejection is benign: callers
 * already treat a failed read as a cache miss / last-known epoch.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	if (!(ms > 0)) return promise;
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			reject(new Error(`object-cache ${label} timed out after ${ms}ms`));
		}, ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface EpochEntry {
	value: number;
	/** `Date.now()` at which this epoch was read from the backend. */
	at: number;
	/** In-flight read, so concurrent callers share one backend round-trip. */
	promise?: Promise<number>;
	/**
	 * `Date.now()` at which the in-flight read started. Callers use it to
	 * decide whether the read's owner can still be alive (see
	 * {@link epochReadDeadline}) — past the deadline the promise is presumed
	 * dead and the next caller reclaims by starting a fresh read.
	 */
	promiseAt?: number;
}

/**
 * Extra time past the configured read timeout before an in-flight epoch read
 * is presumed dead. A live owner's read settles within `timeout` (enforced by
 * {@link withTimeout}), so the grace only needs to absorb scheduling jitter.
 */
const EPOCH_READ_GRACE_MS = 1_000;

/**
 * How long an in-flight epoch read may be trusted. A read older than this can
 * only exist because its owning request was cancelled mid-await — on workerd
 * a cancelled request's continuations never run, *including the timeout's own
 * `setTimeout` callback*, so the shared promise never settles and is never
 * replaced. With the timeout disabled (`timeout: 0`) the default is used as
 * the deadline; the worst case of guessing too short is one duplicate
 * backend read.
 */
function epochReadDeadline(): number {
	const timeout = holder.config.timeout > 0 ? holder.config.timeout : DEFAULT_TIMEOUT_MS;
	return timeout + EPOCH_READ_GRACE_MS;
}

/**
 * Await another request's in-flight epoch read, bounded by the waiter's own
 * timer. The bare promise must never be awaited across requests: if the
 * owning request is cancelled, the promise never settles (see
 * {@link epochReadDeadline}) and an unguarded waiter hangs until the isolate
 * is evicted. The race timer below belongs to the *waiter's* request context
 * and therefore always fires; on timeout the waiter degrades to `fallback`
 * (the last known epoch), the same contract as a failed backend read.
 */
function raceInFlightEpochRead(
	promise: Promise<number>,
	ms: number,
	fallback: number,
): Promise<number> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<number>((resolve) => {
		timer = setTimeout(resolve, Math.max(ms, 1), fallback);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
				timeout: DEFAULT_TIMEOUT_MS,
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
				timeout:
					typeof config.timeout === "number" && config.timeout >= 0
						? config.timeout
						: DEFAULT_TIMEOUT_MS,
			};

			holder.backend =
				typeof mod.createObjectCache === "function" ? mod.createObjectCache(config) : null;
		} catch (error) {
			// Importing the virtual module fails outside an Astro/Vite context
			// (e.g. unit tests, CLI). Treat as "no cache configured".
			if (import.meta.env?.DEV) {
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

/**
 * Build the (epoch-independent) backend key for a cached value.
 *
 * The key is stable across invalidations — the namespace epochs are stored
 * *inside* the value envelope and validated on read, not baked into the key.
 * This lets the value and the epochs be fetched in one parallel round-trip
 * (instead of "read epoch, then read value"), and means an invalidated value
 * is overwritten in place rather than orphaned under a dead epoch-keyed name.
 */
function valueKey(namespaces: readonly string[], key: string): string {
	return `${holder.config.keyPrefix}:${namespaces.join(",")}:${key}`;
}

/**
 * Stored cache envelope: the namespace epochs captured at write time alongside
 * the cached value. A read is a HIT only when every stored epoch still matches
 * the current epoch for its namespace.
 */
interface CacheEnvelope<T> {
	/** Epoch per namespace, in the query's namespace order. */
	e: number[];
	/** The cached value. */
	v: T;
}

function epochsMatch(stored: readonly number[], current: readonly number[]): boolean {
	if (stored.length !== current.length) return false;
	for (let i = 0; i < stored.length; i++) {
		if (stored[i] !== current[i]) return false;
	}
	return true;
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
 * Backend errors and stalls are non-fatal: the read is bounded by a timeout,
 * and on failure we fall back to the last known epoch (or `0`), so a flaky or
 * hung cache degrades to "serve whatever's keyed" rather than throwing or
 * hanging.
 */
async function getEpoch(namespace: string, backend: ObjectCacheBackend): Promise<number> {
	const now = Date.now();
	const cached = epochCache.get(namespace);
	if (cached && now - cached.at < holder.config.revalidate) {
		return cached.value;
	}
	if (cached?.promise) {
		// Share the in-flight read only while its owner can still be alive,
		// and never await it bare (a cancelled owner's promise never settles;
		// see epochReadDeadline). Past the deadline, fall through and reclaim
		// with a fresh read — the dead entry is overwritten below.
		const age = now - (cached.promiseAt ?? 0);
		const deadline = epochReadDeadline();
		if (age < deadline) {
			return raceInFlightEpochRead(cached.promise, deadline - age, cached.value);
		}
	}

	const promise = (async () => {
		let value: number;
		try {
			const raw = await withTimeout(
				backend.get(epochKey(namespace)),
				holder.config.timeout,
				"epoch read",
			);
			const parsed = raw === null ? 0 : Number(raw);
			value = Number.isFinite(parsed) ? parsed : 0;
		} catch {
			value = cached?.value ?? 0;
		}
		// A concurrent invalidateObjectCache may have bumped the epoch while this
		// read was in flight. Epochs are monotonic, so never let a stale backend
		// read lower a freshly-bumped local epoch — that would resurrect the very
		// values the bump just invalidated.
		const merged = Math.max(value, epochCache.get(namespace)?.value ?? 0);
		epochCache.set(namespace, { value: merged, at: Date.now() });
		return merged;
	})();

	// Anchor the read on the host's lifetime extender: if the owning request
	// is cancelled mid-await, the anchored copy keeps the read alive so it
	// still settles and its handler replaces this entry with a fresh,
	// promise-free one. Where no extender exists, the deadline reclaim above
	// recovers instead.
	after(() =>
		promise.then(
			() => undefined,
			() => undefined,
		),
	);

	// Concurrent callers share this in-flight read (dedup) — bounded by their
	// own timers via raceInFlightEpochRead, never awaited bare. The timeout
	// above makes a live owner's read settle; `promiseAt` lets callers detect
	// a dead one (cancelled owner) and reclaim.
	epochCache.set(namespace, {
		value: cached?.value ?? 0,
		at: cached?.at ?? 0,
		promise,
		promiseAt: now,
	});
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
	const fullKey = valueKey(namespaces, options.key);

	// Kick off the value read and every namespace epoch read concurrently — one
	// round-trip instead of "read epochs, then read value". getEpoch never
	// rejects, so awaiting the epochs separately from the value read guarantees
	// we hold the pre-load epochs even when the value read errors or times out.
	// Storing a value under an epoch read *after* load() would mask a write that
	// landed during load(): the stale value would match and be served as a HIT.
	const epochsPromise = Promise.all(namespaces.map((ns) => getEpoch(ns, backend)));
	const rawPromise = withTimeout(backend.get(fullKey), holder.config.timeout, "read").catch(
		() => null,
	);
	const currentEpochs = await epochsPromise;
	const raw = await rawPromise;
	if (raw !== null) {
		const decoded = decode(raw);
		if (decoded !== undefined) {
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- value envelope written by this function
			const envelope = decoded as CacheEnvelope<T>;
			if (epochsMatch(envelope.e, currentEpochs)) {
				return envelope.v;
			}
		}
	}

	const value = await options.load();

	const cacheable = options.cacheable ? options.cacheable(value) : true;
	if (cacheable) {
		const ttl = options.ttl ?? holder.config.defaultTtl;
		// Defer the write so it never adds to TTFB. The epochs were captured
		// before load() ran, so a write that invalidated this namespace mid-load
		// correctly orphans the value stored here.
		after(async () => {
			try {
				const encoded = encode({ e: currentEpochs, v: value } satisfies CacheEnvelope<T>);
				await backend.set(fullKey, encoded, ttl);
			} catch (error) {
				if (import.meta.env?.DEV) {
					console.warn("[object-cache] set failed:", error);
				}
			}
		});
	}

	return value;
}

/** Whether object-cache reads are active for the current request. */
export async function isObjectCacheActive(): Promise<boolean> {
	const backend = await getBackend();
	return backend !== null && !shouldBypass();
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
	// Monotonic so two writes in the same millisecond still produce distinct
	// epochs — otherwise the second write reuses the first's stamp and its
	// stale entries survive.
	const prev = epochCache.get(namespace)?.value ?? 0;
	const stamp = Math.max(prev + 1, Date.now());
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
	/** Collection schema/metadata (label, supports, commentsEnabled, fields). */
	SCHEMA: "schema",
	/** Public (approved) comments. */
	COMMENTS: "comments",
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

/** Invalidate cached collection schema/metadata reads (e.g. getCollectionInfo). */
export function invalidateSchemaObjectCache(): void {
	invalidateObjectCache(CacheNamespace.SCHEMA);
}

/** Invalidate cached public comment reads. */
export function invalidateCommentObjectCache(): void {
	invalidateObjectCache(CacheNamespace.COMMENTS);
}

export type {
	ObjectCacheBackend,
	ObjectCacheDescriptor,
	ObjectCacheRuntimeConfig,
} from "./types.js";
