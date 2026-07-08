import { after } from "../after.js";

/**
 * Backstop timeout for resolving the session user. A live session-store read
 * settles in a few ms, so this only ever fires on a genuinely stalled read.
 */
export const SESSION_GET_TIMEOUT_MS = 3_000;

/**
 * Resolve the Astro session user without risking an isolate-wide hang.
 *
 * On Cloudflare Workers, a request cancelled mid-`session.get()` (client
 * disconnect, context teardown) can leave the underlying session-store read as
 * a promise that never settles — neither resolving nor rejecting. Awaiting it
 * directly hangs the request, and because the stalled promise is shared at the
 * isolate level, every later session-bearing request hangs too (observed as
 * 0-CPU, multi-minute, `canceled` responses; see #1274). A surrounding
 * try/catch cannot help: the promise never rejects.
 *
 * Two layers, mirroring the reclaimable-cache pattern used elsewhere in core:
 *  1. `after()` anchors the read so a cancelled request still drives it to
 *     completion — the promise settles and the isolate is not poisoned for
 *     subsequent requests (prevents the hang rather than merely surviving it).
 *  2. A timeout is a fail-closed backstop: a still-stalled (or rejecting) read
 *     resolves to `undefined`, and every caller treats the absence of a session
 *     user as unauthenticated (anonymous on public routes, 401/redirect on
 *     protected ones). It can only ever drop privileges for that one request,
 *     never grant them.
 *
 * Used by every session read on the request path: the main middleware (the
 * first read on a session-bearing request), the auth middleware, and the
 * preview-snapshot route (which bypasses the auth middleware).
 */
export async function resolveSessionUser<T>(
	session: { get(key: "user"): Promise<T> } | undefined,
	timeoutMs = SESSION_GET_TIMEOUT_MS,
): Promise<T | undefined> {
	if (!session) return undefined;
	const read: Promise<T | undefined> = Promise.resolve(session.get("user")).catch(() => undefined);
	// Keep the worker alive past response/cancellation so the read completes and
	// the shared promise settles — this is what prevents the isolate poisoning.
	after(() =>
		read.then(
			() => undefined,
			() => undefined,
		),
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(resolve, timeoutMs, undefined);
	});
	try {
		return await Promise.race([read, timeout]);
	} finally {
		clearTimeout(timer);
	}
}
