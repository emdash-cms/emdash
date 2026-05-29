/**
 * Byline field-definitions cache
 *
 * Discussion #1174 / Phase 3. Two-tier cache for the byline custom-field
 * registry, mirroring the `settings/index.ts` pattern.
 *
 * **Tier 1 — per-isolate (globalThis).** Field definitions change rarely
 * but are read on every byline hydration (admin pages, content rendering,
 * API responses). Caching at the isolate level drops the SELECT-from-
 * `_emdash_byline_fields` from once-per-hydration to once-per-isolate-
 * after-bump. The cache holds a Promise (not the resolved value) so
 * concurrent cold-isolate readers share the in-flight query.
 *
 * Stored on globalThis under `Symbol.for("emdash:byline-field-defs")` so
 * Vite SSR chunk duplication can't produce two independent caches (same
 * pattern as `request-cache.ts` and `request-context.ts`).
 *
 * **Tier 2 — per-request.** Wraps both the version read and the defs
 * fetch in `requestCached` so a single page render that hits byline
 * hydration multiple times (e.g. list view + individual byline lookups
 * in a sidebar) pays at most one version read and one defs fetch in
 * total. The defs cache key includes the version, so a (highly
 * unlikely) mid-request bump still produces a self-consistent view —
 * the second call sees a different key and refetches.
 *
 * **Invalidation.** `options.byline_fields_version` is bumped by every
 * `BylineSchemaRegistry` mutation (Phase 2). Each isolate independently
 * reads the persisted version on the next request and compares against
 * its cached version; mismatch triggers a refetch and overwrite. Other
 * isolates see the change within one request after the bump propagates.
 *
 * **Isolated databases bypass the global cache.** Playground and DO
 * preview sessions set `requestContext.dbIsIsolated = true`, signalling
 * the per-request `db` points at an isolated schema that may diverge
 * from the singleton. Schema-derived caches keyed by the singleton's
 * version would silently leak the singleton's defs into the isolated
 * request. We follow the `loader.ts:74` `getTaxonomyNames` precedent:
 * skip both reading from and writing to the global holder when the
 * request is isolated. The per-request cache (`requestCached`) is keyed
 * by the WeakMap'd `EmDashRequestContext`, so it can't cross-pollinate
 * between requests — it stays in play even for isolated DBs.
 *
 * **Why a versioned cache and not a TTL?** The version counter gives
 * deterministic invalidation without the staleness window a TTL would
 * impose. Field-definition changes need to be visible to the next
 * request, not eventually. The cost is one cheap `options` read per
 * request — cheaper than the field-defs fetch it replaces, and cheaper
 * than maintaining a TTL state machine.
 */

import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";
import { requestCached } from "../request-cache.js";
import { getRequestContext } from "../request-context.js";
import { BylineSchemaRegistry } from "../schema/byline-registry.js";
import type { BylineFieldDefinition } from "../schema/types.js";

interface FieldDefsHolder {
	/** Cached defs from the last successful fetch. Null until first read. */
	cached: BylineFieldDefinition[] | null;
	/** Persisted-version value that `cached` was fetched against. */
	cachedVersion: number;
}

const HOLDER_KEY = Symbol.for("emdash:byline-field-defs");
const g = globalThis as Record<symbol, unknown>;
const holder: FieldDefsHolder =
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern (see request-cache.ts)
	(g[HOLDER_KEY] as FieldDefsHolder | undefined) ??
	(() => {
		const h: FieldDefsHolder = { cached: null, cachedVersion: -1 };
		g[HOLDER_KEY] = h;
		return h;
	})();

const REQUEST_CACHE_KEY_VERSION = "byline-fields-version";
const REQUEST_CACHE_KEY_DEFS_PREFIX = "byline-field-defs:";

/**
 * Read the persisted `options.byline_fields_version` counter. Cached for
 * the duration of the current request via `requestCached`. Returns `0`
 * when the row is missing (matches `BylineSchemaRegistry.getVersion`).
 */
async function getBylineFieldsVersion(db: Kysely<Database>): Promise<number> {
	return requestCached(REQUEST_CACHE_KEY_VERSION, () => new BylineSchemaRegistry(db).getVersion());
}

/**
 * Resolve registered byline custom-field definitions. Two-tier cache:
 * per-request via `requestCached`, then per-isolate via the global
 * holder.
 *
 * The global holder is bypassed for isolated requests (playground / DO
 * preview, which point at a divergent schema) and for dirty versions
 * (odd counter — see `BylineSchemaRegistry`'s class JSDoc — indicates
 * an in-flight or crashed mutation). Both bypass paths still hit the
 * per-request cache, so a single render dedupes within itself.
 *
 * Always returns an array. Empty = no custom fields registered.
 */
export async function getBylineFieldDefs(db: Kysely<Database>): Promise<BylineFieldDefinition[]> {
	const isolated = getRequestContext()?.dbIsIsolated === true;
	const version = await getBylineFieldsVersion(db);
	const dirty = version % 2 !== 0;
	return requestCached(`${REQUEST_CACHE_KEY_DEFS_PREFIX}${version}`, async () => {
		if (isolated || dirty) {
			return new BylineSchemaRegistry(db).listFields();
		}
		if (holder.cached !== null && holder.cachedVersion === version) {
			return holder.cached;
		}
		const defs = await new BylineSchemaRegistry(db).listFields();
		holder.cached = defs;
		holder.cachedVersion = version;
		return defs;
	});
}

/**
 * Test/internal helper: clear the per-isolate cache. Useful for unit
 * tests that mutate the registry directly and need to force a refetch
 * without going through the full version-bump path.
 *
 * Production code paths should rely on the version counter for
 * invalidation — calling this from a write path would bypass the
 * coordination that lets other isolates see the change.
 */
export function resetBylineFieldDefsCacheForTests(): void {
	holder.cached = null;
	holder.cachedVersion = -1;
}
