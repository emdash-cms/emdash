/**
 * Optimistic mutation helpers for TanStack Query + IndexedDB cache.
 *
 * These helpers create `onMutate` / `onError` / `onSettled` handlers
 * that optimistically update both the TanStack Query cache and IndexedDB,
 * rolling back on error.
 */

import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { StoreNames } from "idb";

import { deleteCached, putCached } from "./cache-store.js";
import type { EmDashCacheDB } from "./db.js";
import { isIDBAvailable } from "./db.js";

/**
 * Create optimistic mutation options for removing an item from a list.
 *
 * Immediately removes the item from the query cache and IndexedDB,
 * rolling back if the mutation fails.
 */
export function optimisticDelete<TItem extends { id: string }>({
	queryClient,
	queryKey,
	store,
}: {
	queryClient: QueryClient;
	queryKey: QueryKey;
	store?: StoreNames<EmDashCacheDB>;
}) {
	return {
		async onMutate(id: string) {
			await queryClient.cancelQueries({ queryKey });
			const previous = queryClient.getQueryData<{ items: TItem[] }>(queryKey);

			if (previous?.items) {
				queryClient.setQueryData<{ items: TItem[] }>(queryKey, {
					...previous,
					items: previous.items.filter((item) => item.id !== id),
				});
			}

			if (store && isIDBAvailable()) {
				await deleteCached(store, id);
			}

			return { previous };
		},
		onError(_error: unknown, _id: string, context: { previous?: { items: TItem[] } } | undefined) {
			if (context?.previous) {
				queryClient.setQueryData(queryKey, context.previous);
			}
		},
		onSettled() {
			void queryClient.invalidateQueries({ queryKey });
		},
	};
}

/**
 * Create optimistic mutation options for updating a single item in cache.
 *
 * Applies the update function to the cached item immediately, rolling
 * back if the mutation fails.
 */
export function optimisticUpdate<TData, TVars>({
	queryClient,
	queryKey,
	store,
	cacheKey,
	apply,
}: {
	queryClient: QueryClient;
	queryKey: QueryKey;
	store?: StoreNames<EmDashCacheDB>;
	cacheKey?: string;
	apply: (current: TData, vars: TVars) => TData;
}) {
	return {
		async onMutate(vars: TVars) {
			await queryClient.cancelQueries({ queryKey });
			const previous = queryClient.getQueryData<TData>(queryKey);

			if (previous !== undefined) {
				const updated = apply(previous, vars);
				queryClient.setQueryData(queryKey, updated);

				if (store && cacheKey && isIDBAvailable()) {
					await putCached(store, cacheKey, updated);
				}
			}

			return { previous };
		},
		onError(_error: unknown, _vars: TVars, context: { previous?: TData } | undefined) {
			if (context?.previous !== undefined) {
				queryClient.setQueryData(queryKey, context.previous);
			}
		},
		onSettled() {
			void queryClient.invalidateQueries({ queryKey });
		},
	};
}

/**
 * Create optimistic mutation options for updating a single item within a list.
 *
 * Finds the item in the list by ID and applies the update function,
 * rolling back if the mutation fails.
 */
export function optimisticListItemUpdate<TItem extends { id: string }, TVars>({
	queryClient,
	queryKey,
	store,
	getId,
	apply,
}: {
	queryClient: QueryClient;
	queryKey: QueryKey;
	store?: StoreNames<EmDashCacheDB>;
	/** Extract the item ID from the mutation variables */
	getId: (vars: TVars) => string;
	/** Apply the optimistic update to the item */
	apply: (item: TItem, vars: TVars) => TItem;
}) {
	return {
		async onMutate(vars: TVars) {
			await queryClient.cancelQueries({ queryKey });
			const previous = queryClient.getQueryData<{ items: TItem[] }>(queryKey);

			if (previous?.items) {
				const id = getId(vars);
				const updatedItems = previous.items.map((item) =>
					item.id === id ? apply(item, vars) : item,
				);
				queryClient.setQueryData<{ items: TItem[] }>(queryKey, {
					...previous,
					items: updatedItems,
				});

				if (store && isIDBAvailable()) {
					const updatedItem = updatedItems.find((item) => item.id === id);
					if (updatedItem) {
						await putCached(store, id, updatedItem);
					}
				}
			}

			return { previous };
		},
		onError(_error: unknown, _vars: TVars, context: { previous?: { items: TItem[] } } | undefined) {
			if (context?.previous) {
				queryClient.setQueryData(queryKey, context.previous);
			}
		},
		onSettled() {
			void queryClient.invalidateQueries({ queryKey });
		},
	};
}
