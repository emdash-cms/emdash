/**
 * Defer work past the HTTP response.
 *
 * Use for bookkeeping that doesn't need to complete before the client
 * gets bytes — writes that record state, maintenance queries, cache
 * refreshes. `after()` hands the promise to the host's lifetime
 * extender when one is available (Cloudflare's `waitUntil` under
 * workerd), or fires-and-forgets on Node (the process lives for the
 * next request anyway).
 *
 * Host binding comes from the `virtual:emdash/wait-until` virtual
 * module, generated per-adapter by the integration — core itself
 * stays runtime-neutral.
 */

// @ts-ignore - virtual module
import { waitUntil } from "virtual:emdash/wait-until";

export type WaitUntilFn = (promise: Promise<unknown>) => void;

/**
 * Schedule `fn` to run without blocking the response.
 *
 * Errors are caught and logged — a deferred task should never surface
 * as an unhandled rejection because the response is long gone. Callers
 * that care about errors should handle them inside `fn`.
 */
export function after(fn: () => void | Promise<void>): void {
	const promise = Promise.resolve()
		.then(fn)
		.catch((error) => {
			console.error("[emdash] deferred task failed:", error);
		});

	if (waitUntil) {
		waitUntil(promise);
		return;
	}
	// No waitUntil (Node, or we're outside a request). The Node event
	// loop keeps the process alive; the promise will run on its own.
	// We've already attached the catch handler above.
}
