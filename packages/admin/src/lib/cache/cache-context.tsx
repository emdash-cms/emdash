/**
 * CacheProvider -- React context that holds pre-warmed cache data,
 * manages background sync, and exposes cache utilities to the app.
 *
 * Wraps the app in App.tsx. On mount, it:
 * 1. Runs cache warmup (pre-load singletons from IndexedDB)
 * 2. Prunes expired entries in the background
 * 3. Starts the background sync manager
 * 4. Sets up multi-tab cache coordination
 */

import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { closeBroadcastChannel, listenForInvalidations } from "./broadcast.js";
import { pruneExpired } from "./cache-store.js";
import type { WarmupData } from "./cache-warmup.js";
import { warmupCache } from "./cache-warmup.js";
import { deleteDatabase, isIDBAvailable } from "./db.js";
import type { SyncManager, SyncStatus } from "./sync.js";
import { createSyncManager } from "./sync.js";

interface CacheContextValue {
	/** Get a pre-warmed singleton value by key */
	getSingleton: <T>(key: string) => T | undefined;
	/** Whether the cache warmup has completed */
	ready: boolean;
	/** Current sync status */
	syncStatus: SyncStatus;
	/** Trigger an immediate sync of all data */
	syncNow: () => void;
	/** Clear the entire IndexedDB cache */
	clearCache: () => Promise<void>;
}

const EMPTY_CONTEXT: CacheContextValue = {
	getSingleton: () => undefined,
	ready: false,
	syncStatus: "idle",
	syncNow: () => {},
	clearCache: async () => {},
};

const CacheContext = React.createContext<CacheContextValue>(EMPTY_CONTEXT);

export function useCacheContext(): CacheContextValue {
	return React.useContext(CacheContext);
}

/**
 * Hook to access the current sync status.
 */
export function useSyncStatus(): SyncStatus {
	return React.useContext(CacheContext).syncStatus;
}

/**
 * Hook to access cache management functions.
 */
export function useCacheActions() {
	const ctx = React.useContext(CacheContext);
	return {
		syncNow: ctx.syncNow,
		clearCache: ctx.clearCache,
	};
}

export function CacheProvider({ children }: { children: React.ReactNode }) {
	const queryClient = useQueryClient();
	const [warmupData, setWarmupData] = React.useState<WarmupData | null>(null);
	const [syncStatus, setSyncStatus] = React.useState<SyncStatus>("idle");
	const syncManagerRef = React.useRef<SyncManager | null>(null);

	// Initialize cache warmup, sync manager, and broadcast channel
	React.useEffect(() => {
		let cancelled = false;

		async function init() {
			// Warmup: pre-load singletons from IndexedDB
			const data = await warmupCache();
			if (!cancelled) {
				setWarmupData(data);
			}
			// Prune expired entries in the background
			void pruneExpired();
		}

		void init();

		// Set up sync manager
		const syncManager = createSyncManager(queryClient);
		syncManagerRef.current = syncManager;

		const unsubscribe = syncManager.subscribe(setSyncStatus);
		syncManager.start();

		// Set up multi-tab coordination
		const stopListening = listenForInvalidations(queryClient);

		return () => {
			cancelled = true;
			syncManager.stop();
			unsubscribe();
			stopListening();
			closeBroadcastChannel();
			syncManagerRef.current = null;
		};
	}, [queryClient]);

	const clearCache = React.useCallback(async () => {
		if (!isIDBAvailable()) return;
		await deleteDatabase();
		// Invalidate all queries so they refetch from the server
		void queryClient.invalidateQueries();
	}, [queryClient]);

	const syncNow = React.useCallback(() => {
		syncManagerRef.current?.syncNow();
	}, []);

	const value = React.useMemo<CacheContextValue>(
		() => ({
			getSingleton: <T,>(key: string): T | undefined => {
				return warmupData?.singletons.get(key) as T | undefined;
			},
			ready: warmupData !== null,
			syncStatus,
			syncNow,
			clearCache,
		}),
		[warmupData, syncStatus, syncNow, clearCache],
	);

	return <CacheContext.Provider value={value}>{children}</CacheContext.Provider>;
}
