/**
 * Playground middleware — injected by the EmDash integration as order: "pre".
 *
 * Runs BEFORE the EmDash runtime init middleware. Creates a per-session
 * Durable Object database, runs migrations, applies the seed, creates an
 * anonymous admin user, and sets the DB in ALS via runWithContext().
 *
 * By the time the runtime middleware runs, the ALS-scoped DB is ready.
 * The runtime's `db` getter checks ALS first, so all init queries
 * (migrations, FTS, cron, manifest) operate on the real DO database.
 *
 * This module is registered via `addMiddleware({ entrypoint: "..." })` in
 * the integration, NOT in the user's src/middleware.ts.
 */

import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";
import { after } from "emdash";
import { Kysely } from "kysely";
import { ulid } from "ulidx";
// @ts-ignore - virtual module populated by EmDash integration at build time
import virtualConfig from "virtual:emdash/config";

import { PreviewDODialect } from "./do-dialect.js";
import { isBlockedInPlayground } from "./do-playground-routes.js";
import type { EmDashPreviewDB } from "./playground-do-class.js";
import { PLAYGROUND_USER } from "./playground-do-class.js";
import { renderPlaygroundLoadingPage } from "./playground-loading.js";
import { renderPlaygroundToolbar } from "./playground-toolbar.js";

/** Default TTL for playground data (1 hour) */
const DEFAULT_TTL = 3600;

/** Cookie name for playground session */
const COOKIE_NAME = "emdash_playground";

const PLAYGROUND_PROGRESS_CONTENT_TYPE = "application/x-ndjson";
const PLAYGROUND_INIT_ERROR = {
	code: "PLAYGROUND_INIT_ERROR",
	message: "Failed to initialize playground",
} as const;

/**
 * Read the DO binding name from the virtual config.
 * The database config has the binding in `config.database.config.binding`.
 */
function getBindingName(): string {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- virtual module import
	const config = virtualConfig as { database?: { config?: { binding?: string } } } | null;
	const binding = config?.database?.config?.binding;
	if (!binding) {
		throw new Error(
			"Playground middleware: no database binding found in config. " +
				"Ensure database: playgroundDatabase({ binding: '...' }) is set.",
		);
	}
	return binding;
}

/**
 * Get a PreviewDBStub for the given session token.
 */
function getStub(binding: string, token: string): DurableObjectStub<EmDashPreviewDB> {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Worker binding from untyped env
	const ns = (env as Record<string, unknown>)[binding];
	if (!ns) {
		throw new Error(`Playground binding "${binding}" not found in environment`);
	}
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- DO namespace from untyped env
	const namespace = ns as DurableObjectNamespace<EmDashPreviewDB>;
	const doId = namespace.idFromName(token);
	return namespace.get(doId);
}

/**
 * Derive a created-at timestamp from the ULID session token.
 */
function getSessionCreatedAt(token: string): string {
	try {
		const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
		let time = 0;
		const chars = token.toUpperCase().slice(0, 10);
		for (const char of chars) {
			time = time * 32 + ENCODING.indexOf(char);
		}
		return new Date(time).toISOString();
	} catch {
		return new Date().toISOString();
	}
}

function createPlaygroundProgressResponse(stream: ReadableStream<Uint8Array>): Response {
	const [client, keepalive] = stream.tee();
	const drain = keepalive.pipeTo(new WritableStream<Uint8Array>());
	after(() => drain);

	return new Response(client, {
		headers: {
			"cache-control": "no-store",
			"content-type": `${PLAYGROUND_PROGRESS_CONTENT_TYPE}; charset=utf-8`,
		},
	});
}

async function consumePlaygroundProgress(stream: ReadableStream<Uint8Array>): Promise<void> {
	const body = await new Response(stream).text();
	let ready = false;

	for (const line of body.split("\n")) {
		if (!line) continue;
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- parsed from the playground DO's private protocol
		const event = JSON.parse(line) as {
			step?: string;
			error?: { code?: string; message?: string };
		};
		if (event.error) throw new Error(event.error.message ?? PLAYGROUND_INIT_ERROR.message);
		if (event.step === "ready") ready = true;
	}

	if (!ready) throw new Error("Playground initialization ended before it was ready");
}

function consumeAnchoredPlaygroundProgress(stream: ReadableStream<Uint8Array>): Promise<void> {
	const completion = consumePlaygroundProgress(stream);
	after(() =>
		completion.then(
			() => undefined,
			() => undefined,
		),
	);
	return completion;
}

/**
 * Inject playground toolbar HTML into an HTML response.
 */
async function injectPlaygroundToolbar(
	response: Response,
	config: { createdAt: string; ttl: number; editMode: boolean },
): Promise<Response> {
	const contentType = response.headers.get("content-type");
	if (!contentType?.includes("text/html")) return response;

	const html = await response.text();
	if (!html.includes("</body>")) return new Response(html, response);

	const toolbarHtml = renderPlaygroundToolbar(config);
	const injected = html.replace("</body>", `${toolbarHtml}</body>`);
	return new Response(injected, {
		status: response.status,
		headers: response.headers,
	});
}

export const onRequest = defineMiddleware(async (context, next) => {
	const { url, cookies } = context;
	const ttl = DEFAULT_TTL;

	// Lazy-load binding name from virtual config
	const binding = getBindingName();

	// --- Entry point: /playground ---
	// Show a loading page immediately. The page calls /_playground/init via
	// fetch to do the actual setup, then redirects to admin when ready.
	// If the session is already initialized, skip the loading page.
	if (url.pathname === "/playground") {
		let token = cookies.get(COOKIE_NAME)?.value;
		if (!token) {
			token = ulid();
			cookies.set(COOKIE_NAME, token, {
				httpOnly: true,
				sameSite: "lax",
				path: "/",
				maxAge: ttl,
			});
		}

		const stub = getStub(binding, token);
		if (await stub.isReady()) {
			return context.redirect("/_emdash/admin");
		}

		return new Response(renderPlaygroundLoadingPage(), {
			status: 200,
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	}

	// --- Init endpoint: called by the loading page ---
	if (url.pathname === "/_playground/init" && context.request.method === "POST") {
		const token = cookies.get(COOKIE_NAME)?.value;
		const wantsProgress = context.request.headers
			.get("accept")
			?.includes(PLAYGROUND_PROGRESS_CONTENT_TYPE);
		if (!token) {
			return Response.json(
				{ error: { code: "NO_SESSION", message: "No playground session" } },
				{ status: 400 },
			);
		}

		const stub = getStub(binding, token);
		try {
			const stream = await stub.initializePlayground(ttl);
			if (wantsProgress) return createPlaygroundProgressResponse(stream);

			await consumeAnchoredPlaygroundProgress(stream);
			return Response.json({ ok: true });
		} catch (error) {
			console.error("Playground initialization failed:", error);
			if (error instanceof Error) {
				console.error(error.stack);
			}
			if (wantsProgress) {
				const body = `${JSON.stringify({ error: PLAYGROUND_INIT_ERROR })}\n`;
				return createPlaygroundProgressResponse(new Response(body).body!);
			}
			return Response.json({ error: PLAYGROUND_INIT_ERROR }, { status: 500 });
		}
	}

	// --- Reset endpoint ---
	// Instead of dropping tables on the old DO (which is fragile and races
	// with cached state), just clear the cookie and redirect to /playground.
	// That creates a brand new DO with a fresh session -- clean slate.
	// The old DO expires via its TTL alarm.
	if (url.pathname === "/_playground/reset") {
		cookies.delete(COOKIE_NAME, { path: "/" });
		return context.redirect("/playground");
	}

	// --- Route gating ---
	if (isBlockedInPlayground(url.pathname)) {
		return Response.json(
			{ error: { code: "PLAYGROUND_MODE", message: "Not available in playground mode" } },
			{ status: 403 },
		);
	}

	// --- Resolve session ---
	const token = cookies.get(COOKIE_NAME)?.value;
	if (!token) {
		// No session -- redirect to /playground to create one
		return context.redirect("/playground");
	}

	// --- Set up DO database and ALS ---
	const stub = getStub(binding, token);
	const dialect = new PreviewDODialect({ getStub: () => stub });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const db = new Kysely<any>({ dialect });

	// Ensure initialized
	try {
		if (!(await stub.isReady())) {
			await consumeAnchoredPlaygroundProgress(await stub.initializePlayground(ttl));
		}
	} catch (error) {
		console.error("Playground initialization failed:", error);
		return Response.json({ error: PLAYGROUND_INIT_ERROR }, { status: 500 });
	}

	// Stash the DO database and user on locals so downstream middleware
	// (runtime init, request-context) can use them. We can't use ALS directly
	// because this middleware is in @emdash-cms/cloudflare and resolves to a
	// different AsyncLocalStorage instance than the emdash core package
	// (workerd loads dist modules separately from Vite's source modules).
	// The request-context middleware (same module context as the loader)
	// detects locals.__playgroundDb and wraps the render in runWithContext().
	// The __playgroundDb property is declared on App.Locals in emdash's locals.d.ts.
	Object.assign(context.locals, { __playgroundDb: db, user: PLAYGROUND_USER });

	const editMode = cookies.get("emdash-edit-mode")?.value === "true";

	const response = await next();

	return injectPlaygroundToolbar(response, {
		createdAt: getSessionCreatedAt(token),
		ttl,
		editMode,
	});
});
