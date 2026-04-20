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
 */

import { defineMiddleware } from "astro:middleware";

import { verifyPreviewToken, parseContentId } from "../../preview/tokens.js";
import { runWithContext } from "../../request-context.js";
import { renderToolbar } from "../../visual-editing/toolbar.js";

/**
 * Inject toolbar HTML into a response if it's an HTML page.
 * Returns the original response if not HTML.
 */
async function injectToolbar(response: Response, toolbarHtml: string): Promise<Response> {
	const contentType = response.headers.get("content-type");
	if (!contentType?.includes("text/html")) return response;

	const html = await response.text();
	if (!html.includes("</body>")) return new Response(html, response);

	const injected = html.replace("</body>", `${toolbarHtml}</body>`);
	return new Response(injected, {
		status: response.status,
		headers: response.headers,
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
	const playgroundDb = context.locals.__playgroundDb;
	if (playgroundDb) {
		// Check if playground user has toggled edit mode on
		const hasEditCookie = cookies.get("emdash-edit-mode")?.value === "true";
		const nonce = context.locals.cspNonce;
		return runWithContext({ editMode: hasEditCookie, db: playgroundDb, nonce }, () => next());
	}

	// Fast path: check for CMS signals before doing any work
	const hasEditCookie = cookies.get("emdash-edit-mode")?.value === "true";
	const hasPreviewToken = url.searchParams.has("_preview");

	// No CMS signals and not an editor → skip everything (zero overhead)
	if (!hasEditCookie && !hasPreviewToken && !isEditor) {
		return next();
	}

	// Determine edit mode: cookie AND authenticated editor
	const editMode = hasEditCookie && isEditor;

	// Read locale from Astro's i18n routing
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Astro context includes currentLocale when i18n is configured
	const locale = (context as { currentLocale?: string }).currentLocale;

	// Verify preview token if present
	let preview: { collection: string; id: string } | undefined;
	if (hasPreviewToken) {
		const secret = import.meta.env.EMDASH_PREVIEW_SECRET || import.meta.env.PREVIEW_SECRET || "";

		if (secret) {
			const result = await verifyPreviewToken({ url, secret });
			if (result.valid) {
				const { collection, id } = parseContentId(result.payload.cid);
				preview = { collection, id };
			}
		}
	}

	// If we have CMS signals, wrap in ALS context
	const needsContext = hasEditCookie || hasPreviewToken;

	if (needsContext) {
		const nonce = context.locals.cspNonce;
		return runWithContext({ editMode, preview, locale, nonce }, async () => {
			let response = await next();

			// Preview responses must not be cached -- draft content could leak past token expiry.
			// Clone the response before modifying headers — the original may be immutable.
			if (preview) {
				response = new Response(response.body, response);
				response.headers.set("Cache-Control", "private, no-store");
			}

			// Inject toolbar for authenticated editors
			if (isEditor) {
				const toolbarHtml = renderToolbar({
					editMode,
					isPreview: !!preview,
					nonce: context.locals.cspNonce,
				});
				return injectToolbar(response, toolbarHtml);
			}

			return response;
		});
	}

	// Editor without CMS signals — no ALS needed, but inject toolbar
	if (isEditor) {
		const response = await next();
		const toolbarHtml = renderToolbar({
			editMode: false,
			isPreview: false,
			nonce: context.locals.cspNonce,
		});
		return injectToolbar(response, toolbarHtml);
	}

	return next();
});

export default onRequest;
