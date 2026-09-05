/**
 * Dev-only hook for regenerating `emdash-env.d.ts` when the schema changes.
 *
 * The Astro integration registers an environment-specific refresh function
 * (filesystem + local HTTP in Node dev, no-op everywhere else). Schema
 * mutation code just triggers the hook, so runtime modules stay free of
 * Node-only I/O.
 */

const REFRESH_FN_KEY = "__emdashDevTypegenRefresh";

export interface DevTypegenRefreshFn {
	(db: unknown): void | Promise<void>;
}

export function setDevTypegenRefresh(fn: DevTypegenRefreshFn): void {
	if (typeof globalThis !== "undefined") {
		Reflect.set(globalThis, REFRESH_FN_KEY, fn);
	}
}

export function refreshDevTypes(db: unknown): void {
	if (typeof import.meta.env === "undefined" || !import.meta.env.DEV) return;

	const fn = Reflect.get(globalThis, REFRESH_FN_KEY);
	if (typeof fn !== "function") return;

	try {
		Promise.resolve(fn(db)).catch((error: unknown) => {
			console.error("[emdash] dev typegen refresh failed:", error);
		});
	} catch (error) {
		console.error("[emdash] dev typegen refresh failed:", error);
	}
}
