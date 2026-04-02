/**
 * useCachedQuery -- a drop-in wrapper around TanStack Query's useQuery
 * that serves cached data from IndexedDB as placeholderData and writes
 * fresh responses back to IndexedDB on success.
 *
 * Components get instant rendering from the cache while the network
 * request runs in the background. If IndexedDB is unavailable, this
 * degrades transparently to a plain useQuery.
 */

import type { QueryKey, UseQueryOptions, UseQueryResult } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { useCacheContext } from "./cache-context.js";
import { getAllByIndex, getCached, putCached, putManyCached } from "./cache-store.js";
import { isIDBAvailable } from "./db.js";

/**
 * Cache configuration for singleton queries (manifest, settings, currentUser).
 */
export interface SingletonCacheConfig {
	store: "singletons";
	key: string;
}

/**
 * Cache configuration for list queries that return FindManyResult<T>.
 * Items are stored individually in IndexedDB and reconstructed into
 * a list shape when serving from cache.
 */
export interface ListCacheConfig<TData, TItem> {
	store: "content" | "media" | "users" | "bylines" | "taxonomyTerms" | "menus" | "sections";
	/** Extract individual items from the query result */
	extractItems: (data: TData) => TItem[];
	/** Reconstruct the list shape from cached items */
	reconstructList: (items: TItem[]) => TData;
	/** Optional filter for items read from the store (e.g., by collection type) */
	filter?: (item: TItem) => boolean;
	/** Index name and value for efficient filtered reads */
	index?: { name: string; value: string };
	/** Extra metadata to store alongside each item (e.g., { type: "posts" }) */
	extra?: (item: TItem) => Record<string, unknown>;
}

/**
 * Cache configuration for detail queries (single entity by ID).
 */
export interface DetailCacheConfig {
	store: "content" | "media" | "users" | "bylines" | "menus" | "sections";
	key: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CacheConfig = SingletonCacheConfig | ListCacheConfig<any, any> | DetailCacheConfig;

export interface UseCachedQueryOptions<
	TQueryFnData,
	TError,
	TData,
	TQueryKey extends QueryKey,
> extends Omit<UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>, "placeholderData"> {
	cache: CacheConfig;
}

function isSingletonConfig(config: CacheConfig): config is SingletonCacheConfig {
	return config.store === "singletons";
}

function isListConfig(config: CacheConfig): config is ListCacheConfig<unknown, unknown> {
	return "extractItems" in config;
}

function isDetailConfig(config: CacheConfig): config is DetailCacheConfig {
	return "key" in config && config.store !== "singletons";
}

/**
 * A useQuery wrapper that integrates IndexedDB caching.
 *
 * On mount, serves cached data as placeholderData for instant rendering.
 * After a successful network fetch, writes fresh data to IndexedDB.
 */
export function useCachedQuery<
	TQueryFnData = unknown,
	TError = Error,
	TData = TQueryFnData,
	TQueryKey extends QueryKey = QueryKey,
>(
	options: UseCachedQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
): UseQueryResult<TData, TError> & { isFromCache: boolean } {
	const { cache, ...queryOptions } = options;
	const cacheCtx = useCacheContext();
	const [cachedData, setCachedData] = React.useState<TData | undefined>(undefined);
	const [loadedFromCache, setLoadedFromCache] = React.useState(false);

	// Load cached data on mount
	React.useEffect(() => {
		if (!isIDBAvailable()) return;

		let cancelled = false;

		async function loadFromCache() {
			try {
				let data: TData | undefined;

				if (isSingletonConfig(cache)) {
					// Check warmup context first, then IndexedDB
					const warmupData = cacheCtx.getSingleton<TData>(cache.key);
					if (warmupData !== undefined) {
						data = warmupData;
					} else {
						data = await getCached<TData>("singletons", cache.key);
					}
				} else if (isDetailConfig(cache)) {
					data = await getCached<TData>(cache.store, cache.key);
				} else if (isListConfig(cache)) {
					const listConfig = cache as ListCacheConfig<TData, unknown>;
					let items: unknown[];
					if (listConfig.index) {
						items = await getAllByIndex(cache.store, listConfig.index.name, listConfig.index.value);
					} else {
						const { getAllCached } = await import("./cache-store.js");
						items = await getAllCached(cache.store);
					}
					if (listConfig.filter) {
						items = items.filter(listConfig.filter);
					}
					if (items.length > 0) {
						data = listConfig.reconstructList(items);
					}
				}

				if (!cancelled && data !== undefined) {
					setCachedData(data);
					setLoadedFromCache(true);
				}
			} catch {
				// Cache read failure -- continue without cache
			}
		}

		void loadFromCache();
		return () => {
			cancelled = true;
		};
	}, [cache, cacheCtx]);

	// Run the query with cached data as placeholderData
	const result = useQuery({
		...queryOptions,
		placeholderData: cachedData as TQueryFnData | undefined,
	} as UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>);

	// Write fresh data to IndexedDB when the query succeeds
	const { data: freshData, isSuccess, isPlaceholderData } = result;

	React.useEffect(() => {
		if (!isSuccess || isPlaceholderData || freshData === undefined || !isIDBAvailable()) return;

		async function writeToCache() {
			try {
				if (isSingletonConfig(cache)) {
					await putCached("singletons", cache.key, freshData);
				} else if (isDetailConfig(cache)) {
					await putCached(cache.store, cache.key, freshData);
				} else if (isListConfig(cache)) {
					const listConfig = cache as ListCacheConfig<TData, unknown>;
					const items = listConfig.extractItems(freshData as TData);
					const records = items.map((item) => ({
						key: (item as Record<string, unknown>).id as string,
						data: item,
						extra: listConfig.extra?.(item),
					}));
					await putManyCached(cache.store, records);
				}
			} catch {
				// Cache write failure is non-fatal
			}
		}

		void writeToCache();
	}, [freshData, isSuccess, isPlaceholderData, cache]);

	const isFromCache = isPlaceholderData && loadedFromCache;

	return {
		...result,
		isFromCache,
	};
}
