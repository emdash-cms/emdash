export const SEARCH_WINDOW_MS = 60_000;
export const SEARCHES_PER_WINDOW = 30;

interface Window {
	start: number;
	count: number;
}

interface Throttle {
	windows: Map<string, Window>;
	sweptAt: number;
}

// Vite can load this module more than once, so the counters live on globalThis.
const THROTTLE = Symbol.for("emdash.plugin-ai-search.search-throttle");

function throttle(): Throttle {
	const global = globalThis as { [THROTTLE]?: Throttle };
	return (global[THROTTLE] ??= { windows: new Map(), sweptAt: 0 });
}

/**
 * Counts a search from `ip` and returns whether it is within this process's
 * per-client limit. Searches from an unknown address are always allowed.
 */
export function allowSearch(ip: string | null, now = Date.now()): boolean {
	if (!ip) return true;
	const state = throttle();
	if (now - state.sweptAt >= SEARCH_WINDOW_MS) {
		for (const [key, window] of state.windows) {
			if (now - window.start >= SEARCH_WINDOW_MS) state.windows.delete(key);
		}
		state.sweptAt = now;
	}
	const current = state.windows.get(ip);
	if (!current || now - current.start >= SEARCH_WINDOW_MS) {
		state.windows.set(ip, { start: now, count: 1 });
		return true;
	}
	current.count++;
	return current.count <= SEARCHES_PER_WINDOW;
}
