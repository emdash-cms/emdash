/**
 * CacheProvider -- React context that holds pre-warmed cache data
 * and exposes it to useCachedQuery hooks throughout the app.
 *
 * Wraps the app in App.tsx. On mount, it runs cache warmup and
 * prunes expired entries in the background.
 */

import * as React from "react";

import { pruneExpired } from "./cache-store.js";
import type { WarmupData } from "./cache-warmup.js";
import { warmupCache } from "./cache-warmup.js";

interface CacheContextValue {
	/** Get a pre-warmed singleton value by key */
	getSingleton: <T>(key: string) => T | undefined;
	/** Whether the cache warmup has completed */
	ready: boolean;
}

const EMPTY_CONTEXT: CacheContextValue = {
	getSingleton: () => undefined,
	ready: false,
};

const CacheContext = React.createContext<CacheContextValue>(EMPTY_CONTEXT);

export function useCacheContext(): CacheContextValue {
	return React.useContext(CacheContext);
}

export function CacheProvider({ children }: { children: React.ReactNode }) {
	const [warmupData, setWarmupData] = React.useState<WarmupData | null>(null);

	React.useEffect(() => {
		let cancelled = false;

		async function init() {
			const data = await warmupCache();
			if (!cancelled) {
				setWarmupData(data);
			}
			// Prune expired entries in the background after warmup
			void pruneExpired();
		}

		void init();
		return () => {
			cancelled = true;
		};
	}, []);

	const value = React.useMemo<CacheContextValue>(
		() => ({
			getSingleton: <T,>(key: string): T | undefined => {
				return warmupData?.singletons.get(key) as T | undefined;
			},
			ready: warmupData !== null,
		}),
		[warmupData],
	);

	return <CacheContext.Provider value={value}>{children}</CacheContext.Provider>;
}
