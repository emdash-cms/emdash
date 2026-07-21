/**
 * EmDash Request Context Middleware
 *
 * Sets up AsyncLocalStorage-based request context for query functions.
 * Skips ALS entirely for logged-out users with no CMS signals (fast path).
 *
 * Handles:
 * - Preview tokens: _preview query param with signed HMAC token
 * - Edit mode: emdash-edit-mode cookie (for visual editing)
 * - Toolbar injection: floating pill for authenticated editors
 * - Client toolbar mode (`toolbar: "client"`): cache-identical HTML with a
 *   client-side bootstrap pill and an `_edit` query param for fresh editor
 *   renders (Discussion #1742)
 */

import type { APIContext } from "astro";
import { defineMiddleware } from "astro:middleware";
// @ts-ignore - virtual module
import virtualConfig from "virtual:emdash/config";

import { resolveSecretsCached } from "#config/secrets.js";

import { verifyPreviewToken, parseContentId } from "../../preview/tokens.js";
import { getRequestContext, runWithContext } from "../../request-context.js";
import { EDIT_PARAM, renderToolbarBootstrap } from "../../visual-editing/toolbar-bootstrap.js";
import { renderToolbar } from "../../visual-editing/toolbar.js";

type ToolbarMode = "server" | "client" | false;

const toolbarMode: ToolbarMode = virtualConfig?.toolbar ?? "server";

/** Astro's route-cache handle. EmDash requires Astro 6+, so it's always present. */
type RouteCache = APIContext["cache"];

/**
 * Opt the current request out of Astro's route cache (e.g. Workers Cache on
 * Cloudflare). `Cache-Control` headers do NOT cover this: the adapter derives
 * the shared-cache TTL from the route-cache options (on Cloudflare via
 * `Cloudflare-CDN-Cache-Control`), so session-specific responses must
 * explicitly disable it or they get stored in the shared cache and served to
 * anonymous visitors without ever invoking the middleware again. With no cache
 * provider configured this is a no-op (`NoopAstroCache`/`DisabledAstroCache`).
 */
function optOutOfRouteCache(cache: RouteCache): void {
	cache.set(false);
}

/**
 * Inject HTML before `</body>` if the response is an HTML page with a body
 * end tag. Does not touch cache headers — callers decide whether the result
 * is still shareable. `injected` tells the caller whether anything changed.
 */
async function injectBeforeBodyEnd(
	response: Response,
	htmlToInject: string,
): Promise<{ response: Response; injected: boolean }> {
	const contentType = response.headers.get("content-type");
	if (!contentType?.includes("text/html")) return { response, injected: false };

	const html = await response.text();
	if (!html.includes("</body>")) {
		// Body already consumed — rebuild the response unchanged.
		return { response: new Response(html, response), injected: false };
	}

	const injected = html.replace("</body>", `${htmlToInject}</body>`);
	return {
		response: new Response(injected, {
			status: response.status,
			headers: response.headers,
		}),
		injected: true,
	};
}

/**
 * Inject toolbar HTML into a response if it's an HTML page.
 * Returns the original response if not HTML.
 */
async function injectToolbar(
	response: Response,
	toolbarHtml: string,
	routeCache: RouteCache,
): Promise<Response> {
	const result = await injectBeforeBodyEnd(response, toolbarHtml);
	if (result.injected) {
		// Toolbar-injected HTML is session-specific (its presence reveals an
		// active editor session); it must never be stored in a shared CDN cache
		// and served to anonymous visitors. Mirrors the preview branch's guard
		// (#1398). `Cache-Control` covers browsers/downstream proxies; the
		// route-cache opt-out covers the shared edge cache, which ignores
		// `Cache-Control`.
		result.response.headers.set("Cache-Control", "private, no-store");
		optOutOfRouteCache(routeCache);
	}
	return result.response;
}

/**
 * Inject the client-toolbar bootstrap script. Identical for every visitor, so
 * cache headers and route-cache options are left untouched and the response
 * stays fully shareable.
 */
async function injectBootstrap(response: Response): Promise<Response> {
	const result = await injectBeforeBodyEnd(response, renderToolbarBootstrap());
	return result.response;
}

/**
 * Redirect an `_edit` URL to its canonical form (same URL without the param).
 * Applied when the requester is not an authenticated editor, so a shared
 * `?_edit` link degrades gracefully for everyone else (Discussion #1742).
 */
function redirectToCanonical(url: URL): Response {
	const canonical = new URL(url);
	canonical.searchParams.delete(EDIT_PARAM);
	return new Response(null, {
		status: 302,
		headers: {
			Location: canonical.pathname + canonical.search + canonical.hash,
			// Header-following caches (Fastly, Varnish, browsers) must not store
			// the redirect — a cached 302 would bounce editors back to the
			// canonical URL. The route-cache opt-out at the call site covers the
			// Workers Cache, which ignores Cache-Control.
			"Cache-Control": "private, no-store",
		},
	});
}

export const onRequest = defineMiddleware(async (context, next) => {
	const { cookies, url } = context;

	// Skip /_emdash routes (admin has its own UI, no rendering context needed)
	if (url.pathname.startsWith("/_emdash")) {
		return next();
	}

	// Check for authenticated editor (role >= 30)
	const { user } = context.locals;
	const isEditor = !!user && user.role >= 30;

	// Playground mode: the playground middleware (from @emdash-cms/cloudflare) stashes
	// the per-session DO database on locals.__playgroundDb. We set it via ALS here
	// (same module instance as the loader) so getDb() picks it up correctly.
	//
	// `dbIsIsolated: true` tells schema-derived caches (manifest, taxonomy defs,
	// byline/term existence probes) to bypass module-scope memoization — each
	// playground session is its own database with its own schema, so a cached
	// value from another session would be wrong.
	const playgroundDb = context.locals.__playgroundDb;
	if (playgroundDb) {
		// Check if playground user has toggled edit mode on
		const hasEditCookie = cookies.get("emdash-edit-mode")?.value === "true";
		return runWithContext({ editMode: hasEditCookie, db: playgroundDb, dbIsIsolated: true }, () =>
			next(),
		);
	}

	// Fast path: check for CMS signals before doing any work
	const hasEditCookie = cookies.get("emdash-edit-mode")?.value === "true";
	const hasPreviewToken = url.searchParams.has("_preview");
	// `_edit` requests a fresh (never cached) editor render; only meaningful in
	// client toolbar mode where public HTML is otherwise identical for everyone.
	const hasEditParam = toolbarMode === "client" && url.searchParams.has(EDIT_PARAM);

	if (hasEditParam) {
		// `_edit` URLs are their own cache key. Never store them in the route
		// cache — a cached anonymous redirect would bounce editors back to the
		// canonical URL, and a cached editor render must never be shared.
		optOutOfRouteCache(context.cache);

		// A non-editor (anonymous, logged-out, or insufficient role) opening an
		// `_edit` URL is sent to the canonical URL — shared `?_edit` links
		// degrade gracefully and never prime a cache entry with page content.
		if (!isEditor) {
			return redirectToCanonical(url);
		}
	}

	// No CMS signals and not an editor → skip everything (zero overhead in
	// server mode; client mode injects the identical-for-everyone bootstrap)
	if (!hasEditCookie && !hasPreviewToken && !isEditor) {
		if (toolbarMode === "client") {
			return injectBootstrap(await next());
		}
		return next();
	}

	// Determine edit mode: cookie AND authenticated editor
	const editMode = hasEditCookie && isEditor;

	// Read locale from Astro's i18n routing
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Astro context includes currentLocale when i18n is configured
	const locale = (context as { currentLocale?: string }).currentLocale;

	const routeCache = context.cache;

	// Verify preview token if present.
	// The preview secret is resolved via `resolveSecretsCached`: env wins,
	// otherwise a DB-stored value is read (or generated on first need).
	// `emdash.db` is set by the runtime middleware which runs first; the
	// only path where it's missing is a runtime-init failure.
	let preview: { collection: string; id: string } | undefined;
	if (hasPreviewToken) {
		const db = context.locals.emdash?.db;
		if (db) {
			const { previewSecret } = await resolveSecretsCached(db);
			const result = await verifyPreviewToken({ url, secret: previewSecret });
			if (result.valid) {
				const { collection, id } = parseContentId(result.payload.cid);
				preview = { collection, id };
			}
		} else {
			console.warn(
				"[emdash] Preview token present but EmDash runtime not initialized; preview disabled.",
			);
		}
	}

	// If we have CMS signals, wrap in ALS context
	const needsContext = hasEditCookie || hasPreviewToken;

	if (needsContext) {
		// Merge with any outer ALS context (e.g. the per-request D1 session db
		// set by the runtime middleware). `storage.run()` replaces the store
		// wholesale, so without the spread the outer `db` would be lost and
		// loaders would fall back to the singleton non-session dialect.
		const parent = getRequestContext();
		return runWithContext({ ...parent, editMode, preview, locale }, async () => {
			let response = await next();

			// Preview responses must not be cached -- draft content could leak past token expiry.
			// Clone the response before modifying headers — the original may be immutable.
			// `Cache-Control` only governs browsers/downstream proxies; the shared
			// edge cache follows the route-cache options, so opt out of those too —
			// otherwise the draft response is stored in the shared cache and served
			// on cache hits without token verification until TTL/purge. Opt out for
			// any request carrying a `_preview` param (valid or not): those URLs are
			// per-token, so cached copies are useless at best and drafts at worst.
			if (hasPreviewToken) {
				optOutOfRouteCache(routeCache);
			}
			if (preview) {
				response = new Response(response.body, response);
				response.headers.set("Cache-Control", "private, no-store");
			}

			// Inject toolbar for authenticated editors. Preview and edit-mode
			// responses are session-specific (`private, no-store` + route-cache
			// opt-out) in every toolbar mode, so the server toolbar is safe to
			// inject here even in client mode.
			if (isEditor && toolbarMode !== false) {
				const toolbarHtml = renderToolbar({
					editMode,
					isPreview: !!preview,
				});
				return injectToolbar(response, toolbarHtml, routeCache);
			}

			// Stale edit cookie without a session (client mode): still serve the
			// shareable bootstrap variant.
			if (toolbarMode === "client" && !isEditor && !preview) {
				return injectBootstrap(response);
			}

			return response;
		});
	}

	// Editor without preview/edit-mode signals.
	if (isEditor) {
		if (toolbarMode === false) {
			return next();
		}

		// Client mode: without the `_edit` param the response must stay
		// byte-identical to the anonymous variant (plus the same bootstrap
		// script), so shared caches serve one entry for everyone. The bootstrap
		// pill is the editor's entry point into the fresh `_edit` render.
		if (toolbarMode === "client" && !hasEditParam) {
			return injectBootstrap(await next());
		}

		// Server mode, or an `_edit` request in client mode: inject the full
		// toolbar (response becomes `private, no-store` and route-cache
		// opted out).
		const response = await next();
		const toolbarHtml = renderToolbar({
			editMode: false,
			isPreview: false,
		});
		return injectToolbar(response, toolbarHtml, routeCache);
	}

	return next();
});

export default onRequest;
