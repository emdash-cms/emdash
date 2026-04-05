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
import { Kysely, sql } from "kysely";
import { ulid } from "ulidx";
// @ts-ignore - virtual module populated by EmDash integration at build time
import virtualConfig from "virtual:emdash/config";

import type { EmDashPreviewDB } from "./do-class.js";
import { PreviewDODialect } from "./do-dialect.js";
import type { PreviewDBStub } from "./do-dialect.js";
import { isBlockedInPlayground } from "./do-playground-routes.js";
import { renderPlaygroundLoadingPage } from "./playground-loading.js";
import { renderPlaygroundToolbar } from "./playground-toolbar.js";

/** Default TTL for playground data (1 hour) */
const DEFAULT_TTL = 3600;

/** Cookie name for playground session */
const COOKIE_NAME = "emdash_playground";

/** Playground admin user constants */
const PLAYGROUND_USER_ID = "playground-admin";
const PLAYGROUND_USER_EMAIL = "playground@emdashcms.com";
const PLAYGROUND_USER_NAME = "Playground User";
const PLAYGROUND_USER_ROLE = 50; // Admin

const PLAYGROUND_USER = {
	id: PLAYGROUND_USER_ID,
	email: PLAYGROUND_USER_EMAIL,
	name: PLAYGROUND_USER_NAME,
	role: PLAYGROUND_USER_ROLE,
};

/** Track which DOs have been initialized this Worker lifetime */
const initializedSessions = new Set<string>();

/**
 * Read the DO binding name from the virtual config.
 * The database config has the binding in `config.database.config.binding`.
 */
function getBindingName(): string {
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- virtual module import
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
function getStub(binding: string, token: string): PreviewDBStub {
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Worker binding from untyped env
	const ns = (env as Record<string, unknown>)[binding];
	if (!ns) {
		throw new Error(`Playground binding "${binding}" not found in environment`);
	}
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- DO namespace from untyped env
	const namespace = ns as DurableObjectNamespace<EmDashPreviewDB>;
	const doId = namespace.idFromName(token);
	const stub = namespace.get(doId);
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- RPC type limitation
	return stub as unknown as PreviewDBStub;
}

/**
 * Get the full DO stub for direct RPC calls (e.g. setTtlAlarm).
 */
function getFullStub(binding: string, token: string): DurableObjectStub<EmDashPreviewDB> {
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Worker binding from untyped env
	const ns = (env as Record<string, unknown>)[binding];
	if (!ns) {
		throw new Error(`Playground binding "${binding}" not found in environment`);
	}
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- DO namespace from untyped env
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

/**
 * Initialize a playground DO: run migrations, apply seed, create admin user.
 */
async function initializePlayground(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	db: Kysely<any>,
	token: string,
): Promise<void> {
	// Check if already initialized (persisted in the DO)
	try {
		const { rows } = await sql<{ value: string }>`
			SELECT value FROM options WHERE name = ${"emdash:setup_complete"}
		`.execute(db);

		if (rows.length > 0) {
			return;
		}
	} catch {
		// Table doesn't exist yet -- first initialization
	}

	console.log(`[playground] Initializing session ${token}`);

	// 1. Run all EmDash migrations.
	// If the DO was previously initialized (persisted state) but somehow the
	// setup_complete flag is missing, migrations may partially fail on tables
	// that already exist. Treat migration errors as non-fatal if there are
	// tables present (i.e. the DO was previously initialized).
	const { runMigrations } = await import("emdash/db");
	try {
		const migrations = await runMigrations(db);
		console.log(`[playground] Migrations applied: ${migrations.applied.length}`);
	} catch (migrationError) {
		// Check if this looks like a "tables already exist" error -- the DO
		// was probably initialized in a previous Worker lifetime and the
		// options check above failed for a transient reason.
		const msg = migrationError instanceof Error ? migrationError.message : String(migrationError);
		if (msg.includes("already exists")) {
			console.log(`[playground] Migrations skipped (tables already exist)`);
			// Mark setup complete if it wasn't (recover from partial init)
			try {
				await sql`
					INSERT OR IGNORE INTO options (name, value)
					VALUES (${"emdash:setup_complete"}, ${JSON.stringify(true)})
				`.execute(db);
			} catch {
				// Best effort
			}
			return;
		}
		throw migrationError;
	}

	// 2. Load and apply seed with content (skip media downloads)
	const { loadSeed } = await import("emdash/seed");
	const { applySeed } = await import("emdash");
	const seed = await loadSeed();
	const seedResult = await applySeed(db, seed, {
		includeContent: true,
		onConflict: "skip",
		skipMediaDownload: true,
	});
	console.log(
		`[playground] Seed applied: ${seedResult.collections.created} collections, ${seedResult.content.created} content entries`,
	);

	// 3. Create anonymous admin user
	const now = new Date().toISOString();
	try {
		await sql`
			INSERT INTO users (id, email, name, role, email_verified, created_at, updated_at)
			VALUES (${PLAYGROUND_USER_ID}, ${PLAYGROUND_USER_EMAIL}, ${PLAYGROUND_USER_NAME},
			        ${PLAYGROUND_USER_ROLE}, ${1}, ${now}, ${now})
		`.execute(db);
	} catch {
		// User might already exist
	}

	// 4. Mark setup complete
	try {
		await sql`
			INSERT INTO options (name, value)
			VALUES (${"emdash:setup_complete"}, ${JSON.stringify(true)})
		`.execute(db);
	} catch {
		// May already exist
	}

	// 5. Set site title
	try {
		await sql`
			INSERT OR REPLACE INTO options (name, value)
			VALUES (${"emdash:site_title"}, ${JSON.stringify("EmDash Playground")})
		`.execute(db);
	} catch {
		// Non-critical
	}

	console.log(`[playground] Session ${token} initialized`);
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

		// Already initialized? Skip the loading page and go straight to admin.
		if (initializedSessions.has(token)) {
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
		if (!token) {
			return Response.json(
				{ error: { code: "NO_SESSION", message: "No playground session" } },
				{ status: 400 },
			);
		}

		if (initializedSessions.has(token)) {
			return Response.json({ ok: true });
		}

		const stub = getStub(binding, token);
		const dialect = new PreviewDODialect({ getStub: () => stub });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const db = new Kysely<any>({ dialect });

		try {
			await initializePlayground(db, token);
			initializedSessions.add(token);
			const fullStub = getFullStub(binding, token);
			await fullStub.setTtlAlarm(ttl);
			return Response.json({ ok: true });
		} catch (error) {
			console.error("Playground initialization failed:", error);
			return Response.json(
				{ error: { code: "PLAYGROUND_INIT_ERROR", message: "Failed to initialize playground" } },
				{ status: 500 },
			);
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
	if (!initializedSessions.has(token)) {
		try {
			await initializePlayground(db, token);
			initializedSessions.add(token);
			const fullStub = getFullStub(binding, token);
			await fullStub.setTtlAlarm(ttl);
		} catch (error) {
			console.error("Playground initialization failed:", error);
			return Response.json(
				{ error: { code: "PLAYGROUND_INIT_ERROR", message: "Failed to initialize playground" } },
				{ status: 500 },
			);
		}
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
