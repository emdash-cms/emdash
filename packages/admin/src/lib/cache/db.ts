/**
 * IndexedDB database setup for the EmDash admin cache.
 *
 * Uses the `idb` library for a typed, promise-based IndexedDB API.
 * The database stores entity-level records with indexes for efficient
 * filtered queries (e.g., content items by collection type).
 */

import { type DBSchema, type IDBPDatabase, openDB } from "idb";

export const DB_NAME = "emdash-admin-cache";
export const DB_VERSION = 1;

export interface CachedRecord<T = unknown> {
	data: T;
	cachedAt: number;
}

export interface QueryMeta {
	queryKey: string;
	lastFetchedAt: number;
	lastServerUpdatedAt?: string;
}

export interface EmDashCacheDB extends DBSchema {
	content: {
		key: string;
		value: CachedRecord & { type: string; updatedAt: string };
		indexes: {
			type: string;
			updatedAt: string;
			"type-updatedAt": [string, string];
		};
	};
	media: {
		key: string;
		value: CachedRecord;
		indexes: { updatedAt: string };
	};
	users: {
		key: string;
		value: CachedRecord;
		indexes: { updatedAt: string };
	};
	bylines: {
		key: string;
		value: CachedRecord;
		indexes: { updatedAt: string };
	};
	taxonomyTerms: {
		key: string;
		value: CachedRecord & { taxonomyName: string };
		indexes: { taxonomyName: string };
	};
	menus: {
		key: string;
		value: CachedRecord;
	};
	sections: {
		key: string;
		value: CachedRecord;
		indexes: { updatedAt: string };
	};
	singletons: {
		key: string;
		value: CachedRecord;
	};
	queryMeta: {
		key: string;
		value: QueryMeta;
	};
}

let dbPromise: Promise<IDBPDatabase<EmDashCacheDB>> | null = null;

/**
 * Get a connection to the cache database. Returns the same promise
 * on subsequent calls (singleton pattern).
 */
export function getDB(): Promise<IDBPDatabase<EmDashCacheDB>> {
	if (!dbPromise) {
		dbPromise = openDB<EmDashCacheDB>(DB_NAME, DB_VERSION, {
			upgrade(db) {
				// Content items -- indexed by collection type and updatedAt
				const contentStore = db.createObjectStore("content", { keyPath: "data.id" });
				contentStore.createIndex("type", "type");
				contentStore.createIndex("updatedAt", "updatedAt");
				contentStore.createIndex("type-updatedAt", ["type", "updatedAt"]);

				// Media metadata
				const mediaStore = db.createObjectStore("media", { keyPath: "data.id" });
				mediaStore.createIndex("updatedAt", "data.updatedAt");

				// Users
				const usersStore = db.createObjectStore("users", { keyPath: "data.id" });
				usersStore.createIndex("updatedAt", "data.updatedAt");

				// Bylines
				const bylinesStore = db.createObjectStore("bylines", { keyPath: "data.id" });
				bylinesStore.createIndex("updatedAt", "data.updatedAt");

				// Taxonomy terms
				const termsStore = db.createObjectStore("taxonomyTerms", {
					keyPath: "data.id",
				});
				termsStore.createIndex("taxonomyName", "taxonomyName");

				// Menus
				db.createObjectStore("menus", { keyPath: "data.id" });

				// Sections
				const sectionsStore = db.createObjectStore("sections", {
					keyPath: "data.id",
				});
				sectionsStore.createIndex("updatedAt", "data.updatedAt");

				// Singletons (manifest, settings, currentUser)
				db.createObjectStore("singletons");

				// Query metadata for sync tracking
				db.createObjectStore("queryMeta");
			},
			blocked() {
				// Another tab has an older version open -- close it
				dbPromise = null;
			},
			blocking() {
				// This tab's connection is blocking an upgrade in another tab
				void dbPromise?.then((db) => db.close());
				dbPromise = null;
			},
		}).catch((err) => {
			// IndexedDB unavailable -- reset so next call retries
			dbPromise = null;
			throw err;
		});
	}
	return dbPromise;
}

/**
 * Check whether IndexedDB is available in the current environment.
 */
export function isIDBAvailable(): boolean {
	return typeof indexedDB !== "undefined";
}

/**
 * Delete the entire cache database. Used for recovery from corruption
 * or when the user explicitly clears the cache.
 */
export async function deleteDatabase(): Promise<void> {
	if (dbPromise) {
		const db = await dbPromise;
		db.close();
		dbPromise = null;
	}
	indexedDB.deleteDatabase(DB_NAME);
}
