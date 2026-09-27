/**
 * Dev-only signal for regenerating `emdash-env.d.ts` when the schema changes.
 *
 * Schema mutations send an event over the Vite module runner's hot channel;
 * the Astro integration listens for it in Node and does the filesystem work.
 * The hot channel crosses realms (workerd under the Cloudflare adapter), and
 * runtime modules stay free of Node-only I/O.
 */

export const DEV_TYPEGEN_REFRESH_EVENT = "emdash:typegen-refresh";

export function refreshDevTypes(): void {
	if (typeof import.meta.env === "undefined" || !import.meta.env.DEV) return;

	try {
		import.meta.hot?.send(DEV_TYPEGEN_REFRESH_EVENT);
	} catch (error) {
		console.error("[emdash] dev typegen refresh failed:", error);
	}
}
