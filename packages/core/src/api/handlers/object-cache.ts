/**
 * Object-cache purge handlers.
 *
 * Epoch-based invalidation for the optional distributed object cache
 * (KV / memory). Safe when no object cache is configured — helpers no-op.
 */

import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import {
	CacheNamespace,
	contentNamespace,
	invalidateBylineObjectCache,
	invalidateCommentObjectCache,
	invalidateMenuObjectCache,
	invalidateObjectCache,
	invalidateSchemaObjectCache,
	invalidateTaxonomyObjectCache,
	isObjectCacheConfigured,
} from "../../object-cache/index.js";
import { SchemaRegistry } from "../../schema/registry.js";
import { invalidateSiteSettingsCache } from "../../settings/index.js";
import type { ApiResult } from "../types.js";

/** Fixed namespaces that are not collection-scoped content reads. */
export const FIXED_OBJECT_CACHE_NAMESPACES = [
	CacheNamespace.SETTINGS,
	CacheNamespace.MENUS,
	CacheNamespace.TAXONOMIES,
	CacheNamespace.BYLINES,
	CacheNamespace.SCHEMA,
	CacheNamespace.COMMENTS,
] as const;

export type FixedObjectCacheNamespace = (typeof FIXED_OBJECT_CACHE_NAMESPACES)[number];

export interface ObjectCachePurgeInput {
	/**
	 * Namespaces to invalidate. Omit or pass `["*"]` to purge every known
	 * namespace (fixed chrome + each content collection).
	 */
	namespaces?: string[];
}

export interface ObjectCacheStatus {
	/** Whether an object-cache backend is configured for this site. */
	configured: boolean;
}

export interface ObjectCachePurgeResult {
	/** Whether an object-cache backend is configured for this site. */
	configured: boolean;
	/** @deprecated Use {@link ObjectCachePurgeResult.configured}. */
	active: boolean;
	/** Namespaces whose epochs were bumped. */
	purged: string[];
}

const ALL_SENTINEL = "*";
const CONTENT_PREFIX = "content:";
const COLLECTION_SLUG_RE = /^[a-z][a-z0-9_]*$/;

function isFixedNamespace(value: string): value is FixedObjectCacheNamespace {
	return (FIXED_OBJECT_CACHE_NAMESPACES as readonly string[]).includes(value);
}

function purgeFixed(namespace: FixedObjectCacheNamespace): void {
	switch (namespace) {
		case CacheNamespace.SETTINGS:
			// Also clears the isolate-local site-settings single-flight cache.
			invalidateSiteSettingsCache();
			break;
		case CacheNamespace.MENUS:
			invalidateMenuObjectCache();
			break;
		case CacheNamespace.TAXONOMIES:
			invalidateTaxonomyObjectCache();
			break;
		case CacheNamespace.BYLINES:
			invalidateBylineObjectCache();
			break;
		case CacheNamespace.SCHEMA:
			invalidateSchemaObjectCache();
			break;
		case CacheNamespace.COMMENTS:
			invalidateCommentObjectCache();
			break;
	}
}

/**
 * Resolve the set of namespaces to purge from the request body and DB.
 */
export async function resolveObjectCacheNamespaces(
	db: Kysely<Database>,
	input: ObjectCachePurgeInput = {},
): Promise<ApiResult<string[]>> {
	const requested = input.namespaces;
	const purgeAll =
		requested === undefined ||
		requested.length === 0 ||
		requested.some((ns) => ns === ALL_SENTINEL);

	if (purgeAll) {
		const collections = await new SchemaRegistry(db).listCollections();
		const contentNs = collections.map((c) => contentNamespace(c.slug));
		return {
			success: true,
			data: [...FIXED_OBJECT_CACHE_NAMESPACES, ...contentNs],
		};
	}

	const resolved: string[] = [];
	const seen = new Set<string>();

	for (const raw of requested) {
		const ns = raw.trim();
		if (!ns || ns === ALL_SENTINEL) continue;
		if (seen.has(ns)) continue;

		if (isFixedNamespace(ns)) {
			seen.add(ns);
			resolved.push(ns);
			continue;
		}

		if (ns.startsWith(CONTENT_PREFIX)) {
			const collection = ns.slice(CONTENT_PREFIX.length);
			if (!COLLECTION_SLUG_RE.test(collection)) {
				return {
					success: false,
					error: {
						code: "VALIDATION_ERROR",
						message: `Invalid content namespace: ${ns}`,
					},
				};
			}
			seen.add(ns);
			resolved.push(ns);
			continue;
		}

		// Bare collection slug → content:{slug}
		if (COLLECTION_SLUG_RE.test(ns)) {
			const full = contentNamespace(ns);
			if (!seen.has(full)) {
				seen.add(full);
				resolved.push(full);
			}
			continue;
		}

		return {
			success: false,
			error: {
				code: "VALIDATION_ERROR",
				message: `Unknown object-cache namespace: ${ns}`,
			},
		};
	}

	return { success: true, data: resolved };
}

/**
 * Bump epochs for the given namespaces (or every known namespace).
 */
export async function handleObjectCachePurge(
	db: Kysely<Database>,
	input: ObjectCachePurgeInput = {},
): Promise<ApiResult<ObjectCachePurgeResult>> {
	try {
		const resolved = await resolveObjectCacheNamespaces(db, input);
		if (!resolved.success) return resolved;

		const purged = resolved.data;
		for (const ns of purged) {
			if (isFixedNamespace(ns)) {
				purgeFixed(ns);
			} else {
				invalidateObjectCache(ns);
			}
		}

		const configured = await isObjectCacheConfigured();
		return {
			success: true,
			data: { configured, active: configured, purged },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "OBJECT_CACHE_PURGE_ERROR",
				message: "Failed to purge object cache",
			},
		};
	}
}

/**
 * Report whether an object-cache backend is configured.
 */
export async function handleObjectCacheStatus(): Promise<ApiResult<ObjectCacheStatus>> {
	try {
		const configured = await isObjectCacheConfigured();
		return { success: true, data: { configured } };
	} catch {
		return {
			success: false,
			error: {
				code: "OBJECT_CACHE_STATUS_ERROR",
				message: "Failed to read object cache status",
			},
		};
	}
}
