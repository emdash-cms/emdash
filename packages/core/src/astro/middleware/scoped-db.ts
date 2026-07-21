/**
 * Request-scoped database lifecycle helpers.
 *
 * Extracted from middleware.ts so they can be unit-tested without pulling in
 * the virtual:emdash/* module graph. The middleware imports these to settle a
 * request-scoped db adapter's lifecycle around the response.
 */

/**
 * Astro attaches AstroCookies to outgoing responses via a well-known global
 * symbol. Cloning a Response (`new Response(body, init)`) drops non-header
 * metadata, so any helper that wraps the response must explicitly forward this
 * symbol or `cookies.set()` calls will be silently dropped. `Symbol.for`
 * returns the same registry symbol everywhere, so this matches the copy in
 * middleware.ts.
 */
export const ASTRO_COOKIES_SYMBOL = Symbol.for("astro.cookies");

/**
 * Run a request-scoped db's `close()` once the response body has finished
 * streaming. Astro streams HTML and components issue DB queries during that
 * stream, so a connection-backed adapter (e.g. Postgres over Hyperdrive) must
 * not be torn down until the body is flushed. Bodyless responses (redirects,
 * 304s, errors) close immediately. A guard makes close idempotent and a stream
 * `cancel` (client disconnect) still triggers it so connections never leak.
 *
 * No-op for adapters without a `close` (D1): the response passes through.
 */
export function wrapResponseForScopedClose(response: Response, close: () => void): Response {
	let closed = false;
	const runClose = () => {
		if (closed) return;
		closed = true;
		try {
			close();
		} catch (error) {
			console.error("[emdash] request-scoped db close failed:", error);
		}
	};

	if (!response.body) {
		runClose();
		return response;
	}

	const transform = new TransformStream<Uint8Array, Uint8Array>({
		flush: runClose,
		cancel: runClose,
	});
	const wrapped = new Response(response.body.pipeThrough(transform), response);
	const astroCookies = Reflect.get(response, ASTRO_COOKIES_SYMBOL);
	if (astroCookies !== undefined) {
		Reflect.set(wrapped, ASTRO_COOKIES_SYMBOL, astroCookies);
	}
	// Byte counts are preserved by the identity transform, but a stale
	// Content-Length on a reconstructed streaming Response risks truncation.
	wrapped.headers.delete("Content-Length");
	return wrapped;
}

/**
 * Run the request body under a request-scoped db, then settle its lifecycle:
 * `commit()` runs before the response is returned (so per-request state like a
 * D1 bookmark cookie is persisted in the headers, even if render throws), while
 * `close()` (if any) is deferred to stream-end so a connection-backed adapter
 * isn't torn down mid-render. On error the connection is closed immediately
 * before rethrowing so it never leaks.
 *
 * On the error path both `commit()` and `close()` are defended: a throw from
 * either is logged and swallowed so it can't replace the propagating render
 * error (which is the one the caller needs to see). On the success path
 * `commit()` is guarded too — if it throws, the connection is closed before the
 * failure is surfaced, so it never leaks. For the current adapters `commit()`
 * is a no-op (Hyperdrive) or a cookie write (D1, no `close`) and `close()` is
 * fire-and-forget, so these guards only matter for a future connection-backed
 * adapter with throwing teardown, but the helper is generic and must not leak
 * or mask.
 */
export async function finishScoped(
	scoped: { commit: () => void; close?: () => void },
	run: () => Promise<Response>,
): Promise<Response> {
	let response: Response;
	try {
		response = await run();
	} catch (error) {
		// A render error is already propagating; neither commit nor close may
		// mask it, and close must still run so the connection doesn't leak.
		commitSafely(scoped.commit);
		closeSafely(scoped.close);
		throw error;
	}
	try {
		scoped.commit();
	} catch (error) {
		// commit() failed on the success path: close the connection now (the
		// response won't be wrapped, so stream-end close would never run) and
		// surface the failure. close is swallowed so it can't mask the commit
		// error that the caller needs to see.
		closeSafely(scoped.close);
		throw error;
	}
	return scoped.close ? wrapResponseForScopedClose(response, scoped.close) : response;
}

/**
 * Run commit() swallowing any error. Used where an exception is already
 * propagating (or about to be thrown) and a commit failure must neither mask it
 * nor skip the subsequent close().
 */
function commitSafely(commit: () => void): void {
	try {
		commit();
	} catch (error) {
		console.error("[emdash] request-scoped db commit failed during error handling:", error);
	}
}

/**
 * Run close() swallowing any error. Used on the error/commit-failure paths
 * where another exception is the one the caller must see; a throwing teardown
 * must not replace it.
 */
function closeSafely(close: (() => void) | undefined): void {
	if (!close) return;
	try {
		close();
	} catch (error) {
		console.error("[emdash] request-scoped db close failed during error handling:", error);
	}
}
