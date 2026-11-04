/**
 * Dev-only signal for regenerating `emdash-env.d.ts` when the schema changes.
 *
 * Schema mutations send an event over the Vite module runner's hot channel;
 * the Astro integration listens for it in Node and does the filesystem work.
 * The hot channel crosses realms (workerd under the Cloudflare adapter), and
 * runtime modules stay free of Node-only I/O. When HMR is disabled there is
 * no hot channel, so the integration also registers a same-realm global.
 */

export const DEV_TYPEGEN_REFRESH_EVENT = "emdash:typegen-refresh";

export const DEV_TYPEGEN_REFRESH_GLOBAL = "__emdashDevTypegenRefresh";

export function refreshDevTypes(): void {
	if (typeof import.meta.env === "undefined" || !import.meta.env.DEV) return;

	try {
		if (import.meta.hot) {
			import.meta.hot.send(DEV_TYPEGEN_REFRESH_EVENT);
			return;
		}
		const fn = Reflect.get(globalThis, DEV_TYPEGEN_REFRESH_GLOBAL);
		if (typeof fn === "function") fn();
	} catch (error) {
		console.error("[emdash] dev typegen refresh failed:", error);
	}
}
