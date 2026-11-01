import { after } from "../after.js";
import {
	createSingleFlightCache,
	invalidateSingleFlightCache,
	singleFlightCached,
	type SingleFlightCache,
} from "./single-flight-cache.js";

export const REVALIDATING_CACHE_TTL_MS = 30_000;

export interface RevalidatingCache<T> {
	snapshot: { value: T } | null;
	expiresAt: number;
	generation: number;
	revalidatingUntil: number;
	refresh: SingleFlightCache<T>;
}

export function createRevalidatingCache<T>(): RevalidatingCache<T> {
	return {
		snapshot: null,
		expiresAt: 0,
		generation: 0,
		revalidatingUntil: 0,
		refresh: createSingleFlightCache<T>(),
	};
}

export function invalidateRevalidatingCache<T>(cache: RevalidatingCache<T>): void {
	cache.generation++;
	cache.snapshot = null;
	cache.expiresAt = 0;
	cache.revalidatingUntil = 0;
	invalidateSingleFlightCache(cache.refresh);
}

/** Serve the last good snapshot while an expired value refreshes via after(). */
export async function revalidatingCached<T>(
	cache: RevalidatingCache<T>,
	load: () => Promise<T>,
	onError: (error: unknown) => void,
): Promise<T> {
	const refresh = (): Promise<T> =>
		singleFlightCached(cache.refresh, load, {
			anchor: (promise) => after(() => promise),
			ownerTimeoutMs: REVALIDATING_CACHE_TTL_MS,
		});

	const install = (value: T) => {
		cache.snapshot = { value };
		cache.expiresAt = Date.now() + REVALIDATING_CACHE_TTL_MS;
	};

	const revalidate = () => {
		const now = Date.now();
		if (cache.revalidatingUntil > now) return;
		cache.revalidatingUntil = now + REVALIDATING_CACHE_TTL_MS;
		const generation = ++cache.generation;
		invalidateSingleFlightCache(cache.refresh);
		after(async () => {
			try {
				const value = await refresh();
				if (generation === cache.generation) install(value);
			} catch (error) {
				onError(error);
			}
		});
	};

	for (let attempt = 0; attempt < 3; attempt++) {
		const snapshot = cache.snapshot;
		if (snapshot) {
			if (Date.now() >= cache.expiresAt) revalidate();
			return snapshot.value;
		}
		const generation = cache.generation;
		const loaded = await refresh();
		if (generation === cache.generation) {
			install(loaded);
			return loaded;
		}
		if (attempt === 2) return loaded;
	}
	throw new Error("Revalidating cache refresh exhausted without loading value");
}
