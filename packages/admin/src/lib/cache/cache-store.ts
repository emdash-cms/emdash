/**
 * Low-level cache store operations for reading/writing entities to IndexedDB.
 *
 * All operations are wrapped in try/catch so that IndexedDB failures
 * never break the application -- the cache is always best-effort.
 */

import type { StoreNames } from "idb";

import type { CachedRecord, EmDashCacheDB } from "./db.js";
import { getDB, isIDBAvailable } from "./db.js";

/** TTL constants in milliseconds */
export const TTL = {
	SINGLETON: 24 * 60 * 60 * 1000, // 24 hours
	ENTITY: 7 * 24 * 60 * 60 * 1000, // 7 days
} as const;

/**
 * Get a single cached record from a store.
 */
export async function getCached<T>(
	storeName: StoreNames<EmDashCacheDB>,
	key: string,
): Promise<T | undefined> {
	if (!isIDBAvailable()) return undefined;
	try {
		const db = await getDB();
		const record = (await db.get(storeName, key)) as CachedRecord<T> | undefined;
		if (!record) return undefined;

		const ttl = storeName === "singletons" ? TTL.SINGLETON : TTL.ENTITY;
		if (Date.now() - record.cachedAt > ttl) {
			// Expired -- delete and return undefined
			await db.delete(storeName, key).catch(() => {});
			return undefined;
		}
		return record.data;
	} catch {
		return undefined;
	}
}

/**
 * Put a record into a store, wrapping it with cache metadata.
 */
export async function putCached<T>(
	storeName: StoreNames<EmDashCacheDB>,
	key: string,
	data: T,
	extra?: Record<string, unknown>,
): Promise<void> {
	if (!isIDBAvailable()) return;
	try {
		const db = await getDB();
		const record = { data, cachedAt: Date.now(), ...extra };
		await db.put(
			storeName,
			record as never,
			storeName === "singletons" || storeName === "queryMeta" ? key : undefined,
		);
	} catch {
		// Cache write failure is non-fatal
	}
}

/**
 * Put multiple records into a store in a single transaction.
 */
export async function putManyCached<T>(
	storeName: StoreNames<EmDashCacheDB>,
	items: Array<{ key: string; data: T; extra?: Record<string, unknown> }>,
): Promise<void> {
	if (!isIDBAvailable() || items.length === 0) return;
	try {
		const db = await getDB();
		const tx = db.transaction(storeName, "readwrite");
		const store = tx.store;
		const now = Date.now();
		for (const item of items) {
			const record = { data: item.data, cachedAt: now, ...item.extra };
			await store.put(
				record as never,
				storeName === "singletons" || storeName === "queryMeta" ? item.key : undefined,
			);
		}
		await tx.done;
	} catch {
		// Cache write failure is non-fatal
	}
}

/**
 * Get all records from a store, filtering out expired entries.
 */
export async function getAllCached<T>(storeName: StoreNames<EmDashCacheDB>): Promise<T[]> {
	if (!isIDBAvailable()) return [];
	try {
		const db = await getDB();
		const records = (await db.getAll(storeName)) as CachedRecord<T>[];
		const ttl = storeName === "singletons" ? TTL.SINGLETON : TTL.ENTITY;
		const now = Date.now();
		return records.filter((r) => now - r.cachedAt <= ttl).map((r) => r.data);
	} catch {
		return [];
	}
}

/**
 * Get all records from a store matching an index value.
 */
export async function getAllByIndex<T>(
	storeName: StoreNames<EmDashCacheDB>,
	indexName: string,
	value: string,
): Promise<T[]> {
	if (!isIDBAvailable()) return [];
	try {
		const db = await getDB();
		const tx = db.transaction(storeName, "readonly");
		const index = tx.store.index(indexName as never);
		const records = (await index.getAll(IDBKeyRange.only(value))) as CachedRecord<T>[];
		const ttl = TTL.ENTITY;
		const now = Date.now();
		return records.filter((r) => now - r.cachedAt <= ttl).map((r) => r.data);
	} catch {
		return [];
	}
}

/**
 * Delete a single record from a store.
 */
export async function deleteCached(
	storeName: StoreNames<EmDashCacheDB>,
	key: string,
): Promise<void> {
	if (!isIDBAvailable()) return;
	try {
		const db = await getDB();
		await db.delete(storeName, key);
	} catch {
		// Non-fatal
	}
}

/**
 * Clear all records from a store.
 */
export async function clearStore(storeName: StoreNames<EmDashCacheDB>): Promise<void> {
	if (!isIDBAvailable()) return;
	try {
		const db = await getDB();
		await db.clear(storeName);
	} catch {
		// Non-fatal
	}
}

/**
 * Prune expired records from all entity stores.
 * Called on app startup to keep the cache size bounded.
 */
export async function pruneExpired(): Promise<void> {
	if (!isIDBAvailable()) return;
	const entityStores: StoreNames<EmDashCacheDB>[] = [
		"content",
		"media",
		"users",
		"bylines",
		"taxonomyTerms",
		"menus",
		"sections",
	];
	const now = Date.now();
	try {
		const db = await getDB();
		for (const storeName of entityStores) {
			const tx = db.transaction(storeName, "readwrite");
			let cursor = await tx.store.openCursor();
			while (cursor) {
				const record = cursor.value as CachedRecord;
				if (now - record.cachedAt > TTL.ENTITY) {
					await cursor.delete();
				}
				cursor = await cursor.continue();
			}
			await tx.done;
		}
		// Prune singletons
		const singletonTx = db.transaction("singletons", "readwrite");
		let sCursor = await singletonTx.store.openCursor();
		while (sCursor) {
			const record = sCursor.value;
			if (now - record.cachedAt > TTL.SINGLETON) {
				await sCursor.delete();
			}
			sCursor = await sCursor.continue();
		}
		await singletonTx.done;
	} catch {
		// Non-fatal
	}
}
