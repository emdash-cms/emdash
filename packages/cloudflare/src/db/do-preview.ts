/**
 * Preview middleware for Durable Object-backed preview databases.
 *
 * This middleware intercepts requests to a preview service, validates
 * signed preview URLs, creates/resolves DO sessions, populates snapshots,
 * and overrides the request-context DB so all queries route to the
 * isolated DO database.
 *
 * Designed to be registered as Astro middleware in a preview Worker.
 *
 * @example
 * ```ts
 * // src/middleware.ts (in the preview Worker)
 * import { createPreviewMiddleware } from "@emdash-cms/cloudflare/db/do";
 *
 * export const onRequest = createPreviewMiddleware({
 *   binding: "PREVIEW_DB",
 *   secret: import.meta.env.PREVIEW_SECRET,
 * });
 * ```
 */

import type { MiddlewareHandler } from "astro";
import { env } from "cloudflare:workers";
import { runWithContext } from "emdash/request-context";
import { Kysely } from "kysely";
import { ulid } from "ulidx";

import type { Database } from "emdash";
import type { EmDashPreviewDB } from "./do-class.js";
import { PreviewDODialect } from "./do-dialect.js";
import type { PreviewDBStub } from "./do-dialect.js";
import { isBlockedInPreview } from "./do-preview-routes.js";
import { verifyPreviewSignature } from "./do-preview-sign.js";
import { renderPreviewToolbar } from "./preview-toolbar.js";

/** Configuration for the preview middleware */
export interface PreviewMiddlewareConfig {
	/** Durable Object binding name (from wrangler.jsonc) */
	binding: string;
	/** HMAC secret for validating signed preview URLs */
	secret: string;
	/** TTL for preview data in seconds (default: 3600 = 1 hour) */
	ttl?: number;
	/** Cookie name for session token (default: "emdash_preview") */
	cookieName?: string;
}

/**
 * Simple loading interstitial HTML.
 * Auto-reloads after a short delay to check if the snapshot is ready.
 */
function loadingPage(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="2">
<title>Loading preview...</title>
<style>
body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #fafafa; color: #333; }
.spinner { width: 40px; height: 40px; border: 3px solid #e0e0e0; border-top-color: #333; border-radius: 50%; animation: spin 0.8s linear infinite; margin-right: 16px; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="spinner"></div>
<p>Loading preview&hellip;</p>
</body>
</html>`;
}

/**
 * Create an Astro-compatible preview middleware.
 *
 * Returns a middleware function that can be used in `defineMiddleware()`
 * or composed via `sequence()`.
 */
export function createPreviewMiddleware(config: PreviewMiddlewareConfig): MiddlewareHandler {
	const { binding, secret, ttl = 3600, cookieName = "emdash_preview" } = config;

	return async function previewMiddleware(context, next) {
		const { url, cookies } = context;

		// --- 0a. Reload endpoint ---
		// The toolbar POSTs here to clear the httpOnly session cookie and
		// redirect back with the original signed params for a fresh snapshot.
		if (url.pathname === "/_preview/reload") {
			cookies.delete(cookieName, { path: "/" });
			let redirectTo = "/";
			const paramsCookie = cookies.get(`${cookieName}_params`)?.value;
			if (paramsCookie) {
				const parts = decodeURIComponent(paramsCookie).split("\n");
				if (parts.length === 3) {
					const reloadUrl = new URL("/", url.origin);
					reloadUrl.searchParams.set("source", parts[0]!);
					reloadUrl.searchParams.set("exp", parts[1]!);
					reloadUrl.searchParams.set("sig", parts[2]!);
					redirectTo = reloadUrl.pathname + reloadUrl.search;
				}
			}
			return context.redirect(redirectTo);
		}

		// --- 0b. Route gating ---
		// Block admin UI, auth, and setup routes. These depend on state
		// (users, sessions, credentials) that doesn't exist in preview snapshots.
		if (isBlockedInPreview(url.pathname)) {
			return Response.json(
				{ error: { code: "PREVIEW_MODE", message: "Not available in preview mode" } },
				{ status: 403 },
			);
		}

		// --- 1. Resolve session token ---
		let sessionToken: string | undefined = cookies.get(cookieName)?.value;
		let sourceUrl: string | null = null;
		let snapshotSignature: string | null = null;

		if (!sessionToken) {
			// No cookie — must have a signed URL
			const source = url.searchParams.get("source");
			const exp = url.searchParams.get("exp");
			const sig = url.searchParams.get("sig");

			if (!source || !exp || !sig) {
				return new Response("Missing preview parameters", { status: 400 });
			}

			const expNum = parseInt(exp, 10);
			if (isNaN(expNum) || expNum < Date.now() / 1000) {
				return new Response("Preview link expired", { status: 403 });
			}

			const valid = await verifyPreviewSignature(source, expNum, sig, secret);
			if (!valid) {
				return new Response("Invalid preview signature", { status: 403 });
			}

			// Generate session
			sessionToken = ulid();
			sourceUrl = source;
			// Build the signature header value for snapshot fetch: "source:exp:sig"
			snapshotSignature = `${source}:${exp}:${sig}`;

			cookies.set(cookieName, sessionToken, {
				httpOnly: true,
				sameSite: "lax",
				path: "/",
				maxAge: ttl,
			});
			// Store the signed params so the toolbar can trigger a reload.
			// Not httpOnly — the toolbar script needs to read them.
			cookies.set(`${cookieName}_params`, `${source}\n${exp}\n${sig}`, {
				sameSite: "lax",
				path: "/",
				maxAge: ttl,
			});
		}

		// --- 2. Get DO stub ---
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Worker binding from untyped env
		const ns = (env as Record<string, unknown>)[binding];
		if (!ns) {
			console.error(`Preview binding "${binding}" not found in environment`);
			return new Response("Preview service misconfigured", { status: 500 });
		}
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- DO namespace from untyped env
		const namespace = ns as DurableObjectNamespace<EmDashPreviewDB>;
		const doId = namespace.idFromName(sessionToken);
		const stub = namespace.get(doId);

		// --- 3. Populate from snapshot if needed ---
		let snapshotGeneratedAt: string | undefined;
		let snapshotError: string | undefined;

		if (!sourceUrl) {
			// Returning session — get metadata from the DO
			try {
				const meta = await stub.getSnapshotMeta();
				snapshotGeneratedAt = meta?.generatedAt;
			} catch {
				// DO may have expired or been cleaned up
			}
		}

		if (sourceUrl && snapshotSignature) {
			try {
				// Pass the full signature header value (source:exp:sig) so the DO
				// can send it as X-Preview-Signature when fetching the snapshot.
				const result = await stub.populateFromSnapshot(sourceUrl, snapshotSignature, { ttl });
				snapshotGeneratedAt = result.generatedAt;

				// Snapshot loaded — redirect to strip signed params from the URL.
				// Astro's cookie buffer flushes on context.redirect().
				const cleanUrl = new URL(url);
				cleanUrl.searchParams.delete("source");
				cleanUrl.searchParams.delete("exp");
				cleanUrl.searchParams.delete("sig");
				return context.redirect(cleanUrl.pathname + cleanUrl.search);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error("Failed to populate preview snapshot:", message);
				snapshotError = message;

				// If this is the initial load (no session yet), show a loading page.
				// If we already have a session, continue with stale data and show the error in the toolbar.
				if (!cookies.get(cookieName)?.value) {
					return new Response(loadingPage(), {
						status: 503,
						headers: {
							"Content-Type": "text/html",
							"Retry-After": "2",
						},
					});
				}
			}
		}

		// --- 4. Create Kysely dialect pointing at the DO ---
		const getStub = (): PreviewDBStub => {
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- RPC type limitation
			return stub as PreviewDBStub;
		};
		const dialect = new PreviewDODialect({ getStub });

		// --- 5. Create Kysely instance and override request-context DB ---
	const previewDb = new Kysely<Database>({ dialect });

		return runWithContext(
			{
				editMode: false,
				db: previewDb,
			},
			async () => {
				const response = await next();
				return injectPreviewToolbar(response, {
					generatedAt: snapshotGeneratedAt,
					source: sourceUrl ?? undefined,
					error: snapshotError,
				});
			},
		);
	};
}

/**
 * Inject preview toolbar HTML into an HTML response.
 * Returns the original response unchanged for non-HTML responses.
 */
async function injectPreviewToolbar(
	response: Response,
	config: { generatedAt?: string; source?: string; error?: string },
): Promise<Response> {
	const contentType = response.headers.get("content-type");
	if (!contentType?.includes("text/html")) return response;

	const html = await response.text();
	if (!html.includes("</body>")) return new Response(html, response);

	const toolbarHtml = renderPreviewToolbar(config);
	const injected = html.replace("</body>", `${toolbarHtml}</body>`);
	return new Response(injected, {
		status: response.status,
		headers: response.headers,
	});
}
