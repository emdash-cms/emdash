/**
 * EmDash middleware
 *
 * Thin wrapper that initializes EmDashRuntime and attaches it to locals.
 * All heavy lifting happens in EmDashRuntime.
 */

import { defineMiddleware } from "astro:middleware";
import type { Kysely } from "kysely";
// Import from virtual modules (populated by integration at build time)
// @ts-ignore - virtual module
import virtualConfig from "virtual:emdash/config";
// @ts-ignore - virtual module
import {
	createDialect as virtualCreateDialect,
	createRequestScopedDb as virtualCreateRequestScopedDb,
} from "virtual:emdash/dialect";
import type { RequestScopedDbOpts } from "virtual:emdash/dialect";
// @ts-ignore - virtual module
import { mediaProviders as virtualMediaProviders } from "virtual:emdash/media-providers";
// @ts-ignore - virtual module
import { plugins as virtualPlugins } from "virtual:emdash/plugins";
import {
	createSandboxRunner as virtualCreateSandboxRunner,
	sandboxEnabled as virtualSandboxEnabled,
	// @ts-ignore - virtual module
} from "virtual:emdash/sandbox-runner";
// @ts-ignore - virtual module
import { sandboxedPlugins as virtualSandboxedPlugins } from "virtual:emdash/sandboxed-plugins";
// @ts-ignore - virtual module
import { createStorage as virtualCreateStorage } from "virtual:emdash/storage";

import {
	EmDashRuntime,
	type RuntimeDependencies,
	type SandboxedPluginEntry,
	type MediaProviderEntry,
} from "../emdash-runtime.js";
import { setI18nConfig } from "../i18n/config.js";
import type { Database, Storage } from "../index.js";
import type { SandboxRunner } from "../plugins/sandbox/types.js";
import type { ResolvedPlugin } from "../plugins/types.js";
import { getRequestContext, runWithContext } from "../request-context.js";
import type { EmDashConfig } from "./integration/runtime.js";
import type { EmDashHandlers } from "./types.js";

// Cached runtime instance (persists across requests within worker)
let runtimeInstance: EmDashRuntime | null = null;
// Whether initialization is in progress (prevents concurrent init attempts)
let runtimeInitializing = false;

/** Whether i18n config has been initialized from the virtual module */
let i18nInitialized = false;

/**
 * Whether we've verified the database has been set up.
 * On a fresh deployment the first request may hit a public page, bypassing
 * runtime init. Without this check, template helpers like getSiteSettings()
 * would query an empty database and crash. Once verified (or once the runtime
 * has initialized via an admin/API request), this stays true for the worker's
 * lifetime.
 */
let setupVerified = false;

/**
 * Get EmDash configuration from virtual module
 */
function getConfig(): EmDashConfig | null {
	if (virtualConfig && typeof virtualConfig === "object") {
		// Initialize i18n config on first access (once per worker lifetime)
		if (!i18nInitialized) {
			i18nInitialized = true;
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- virtual module checked as object above
			const config = virtualConfig as Record<string, unknown>;
			if (config.i18n && typeof config.i18n === "object") {
				setI18nConfig(
					// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- runtime-checked above
					config.i18n as {
						defaultLocale: string;
						locales: string[];
						fallback?: Record<string, string>;
					},
				);
			} else {
				setI18nConfig(null);
			}
		}

		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- virtual module import is untyped (@ts-ignore above)
		return virtualConfig as EmDashConfig;
	}
	return null;
}

/**
 * Get plugins from virtual module
 */
function getPlugins(): ResolvedPlugin[] {
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- virtual module import is untyped (@ts-ignore above)
	return (virtualPlugins as ResolvedPlugin[]) || [];
}

/**
 * Build runtime dependencies from virtual modules
 */
function buildDependencies(config: EmDashConfig): RuntimeDependencies {
	return {
		config,
		plugins: getPlugins(),
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- virtual module import is untyped (@ts-ignore above)
		createDialect: virtualCreateDialect as (config: Record<string, unknown>) => unknown,
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- virtual module import is untyped (@ts-ignore above)
		createStorage: virtualCreateStorage as ((config: Record<string, unknown>) => Storage) | null,
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- virtual module import is untyped (@ts-ignore above)
		sandboxEnabled: virtualSandboxEnabled as boolean,
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- virtual module import is untyped (@ts-ignore above)
		sandboxedPluginEntries: (virtualSandboxedPlugins as SandboxedPluginEntry[]) || [],
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- virtual module import is untyped (@ts-ignore above)
		createSandboxRunner: virtualCreateSandboxRunner as
			| ((opts: { db: Kysely<Database> }) => SandboxRunner)
			| null,
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- virtual module import is untyped (@ts-ignore above)
		mediaProviderEntries: (virtualMediaProviders as MediaProviderEntry[]) || [],
	};
}

/**
 * Get or create the runtime instance.
 *
 * When `initTimings` is provided, any timing samples recorded during a
 * genuine cold init are appended. Subsequent warm calls (hitting the
 * cached instance) push nothing — callers should treat an empty array
 * as "warm, nothing to report".
 */
async function getRuntime(
	config: EmDashConfig,
	initTimings?: Array<{ name: string; dur: number; desc?: string }>,
): Promise<EmDashRuntime> {
	// Return cached instance if available
	if (runtimeInstance) {
		return runtimeInstance;
	}

	// If another request is already initializing, wait and retry.
	// We don't share the promise across requests because workerd flags
	// cross-request promise resolution (causes warnings + potential hangs).
	if (runtimeInitializing) {
		// Poll until the initializing request finishes
		await new Promise((resolve) => setTimeout(resolve, 50));
		return getRuntime(config, initTimings);
	}

	runtimeInitializing = true;
	try {
		const deps = buildDependencies(config);
		const runtime = await EmDashRuntime.create(deps, initTimings);
		runtimeInstance = runtime;
		return runtime;
	} finally {
		runtimeInitializing = false;
	}
}

/**
 * Astro attaches AstroCookies to outgoing responses via a well-known global
 * symbol. Cloning a Response (`new Response(body, init)`) drops non-header
 * metadata, so any middleware that wraps the response must explicitly forward
 * this symbol or `cookies.set()` calls will be silently dropped.
 */
const ASTRO_COOKIES_SYMBOL = Symbol.for("astro.cookies");

/**
 * Baseline security headers applied to all responses.
 * Admin routes get additional headers (strict CSP) from auth middleware.
 */
function finalizeResponse(
	response: Response,
	serverTimings?: Array<{ name: string; dur: number; desc?: string }>,
): Response {
	const res = new Response(response.body, response);
	const astroCookies = Reflect.get(response, ASTRO_COOKIES_SYMBOL);
	if (astroCookies !== undefined) {
		Reflect.set(res, ASTRO_COOKIES_SYMBOL, astroCookies);
	}
	res.headers.set("X-Content-Type-Options", "nosniff");
	res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
	res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
	if (!res.headers.has("Content-Security-Policy")) {
		res.headers.set("X-Frame-Options", "SAMEORIGIN");
	}
	if (serverTimings && serverTimings.length > 0) {
		res.headers.set(
			"Server-Timing",
			serverTimings
				.map((t) => {
					const dur = Math.round(t.dur);
					return t.desc ? `${t.name};dur=${dur};desc="${t.desc}"` : `${t.name};dur=${dur}`;
				})
				.join(", "),
		);
	}
	return res;
}

/** Public routes that require the runtime (sitemap, robots.txt, etc.) */
const PUBLIC_RUNTIME_ROUTES = new Set(["/sitemap.xml", "/robots.txt"]);
const SITEMAP_COLLECTION_RE = /^\/sitemap-[a-z][a-z0-9_]*\.xml$/;

/**
 * Ask the configured database adapter for a per-request scoped Kysely. The
 * adapter encapsulates any per-request semantics (D1 sessions, read-replica
 * routing, bookmark cookies, etc.); core just forwards the cookie jar and
 * request flags and wraps next() in ALS if a scope was returned.
 */
function createRequestScopedDb(
	opts: RequestScopedDbOpts,
): { db: Kysely<Database>; commit: () => void } | null {
	if (typeof virtualCreateRequestScopedDb !== "function") return null;
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- adapter returns Kysely<unknown>; cast to Database since core owns that type
	const fn = virtualCreateRequestScopedDb as (
		o: RequestScopedDbOpts,
	) => { db: Kysely<Database>; commit: () => void } | null;
	return fn(opts);
}

export const onRequest = defineMiddleware(async (context, next) => {
	const { request, locals, cookies } = context;
	const url = context.url;

	// Process /_emdash routes and public routes with an active session
	// (logged-in editors need the runtime for toolbar/visual editing on public pages)
	const isEmDashRoute = url.pathname.startsWith("/_emdash");
	const isPublicRuntimeRoute =
		PUBLIC_RUNTIME_ROUTES.has(url.pathname) || SITEMAP_COLLECTION_RE.test(url.pathname);

	// Check for edit mode cookie - editors viewing public pages need the runtime
	// so auth middleware can verify their session for visual editing
	const hasEditCookie = cookies.get("emdash-edit-mode")?.value === "true";
	const hasPreviewToken = url.searchParams.has("_preview");

	// Playground mode: the playground middleware stashes the per-session DO database
	// on locals.__playgroundDb. When present, use runWithContext() to make it
	// available to getDb() and the runtime's db getter via the correct ALS instance.
	const playgroundDb = locals.__playgroundDb;

	// Read the Astro session user once up-front. Both the anonymous fast path
	// and the full doInit path need this, and the session store is network-backed
	// (KV / Durable Object) so we want to avoid re-fetching on the hot path.
	// Skipped entirely for prerendered requests — they have no session.
	const sessionUser = context.isPrerendered ? null : await context.session?.get("user");

	if (!isEmDashRoute && !isPublicRuntimeRoute && !hasEditCookie && !hasPreviewToken) {
		if (!sessionUser && !playgroundDb) {
			const timings: Array<{ name: string; dur: number; desc?: string }> = [];
			const mwStart = performance.now();

			// On a fresh deployment the database may be completely empty.
			// Public pages call getSiteSettings() / getMenu() via getDb(), which
			// bypasses runtime init and would crash with "no such table: options".
			// Do a one-time lightweight probe using the same getDb() instance the
			// page will use: if the migrations table doesn't exist, no migrations
			// have ever run -- redirect to the setup wizard.
			if (!setupVerified) {
				const t0 = performance.now();
				try {
					const { getDb } = await import("../loader.js");
					const db = await getDb();
					await db
						.selectFrom("_emdash_migrations" as keyof Database)
						.selectAll()
						.limit(1)
						.execute();
					setupVerified = true;
				} catch {
					// Table doesn't exist -> fresh database, redirect to setup
					return context.redirect("/_emdash/admin/setup");
				}
				timings.push({ name: "setup", dur: performance.now() - t0, desc: "Setup probe" });
			}

			// Initialize the runtime for page:metadata and page:fragments hooks.
			// The runtime is a cached singleton — after the first request,
			// getRuntime() is just a null-check. This enables SEO plugins to
			// contribute meta tags for all visitors, not just logged-in editors.
			const config = getConfig();
			if (config) {
				// Sub-phase timings are populated only on the cold init. Warm
				// requests hit the cached runtime and leave this empty.
				const initSubTimings: Array<{ name: string; dur: number; desc?: string }> = [];
				const t0 = performance.now();
				try {
					const runtime = await getRuntime(config, initSubTimings);
					setupVerified = true;
					// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- partial object; getPageRuntime() only checks for these two methods
					locals.emdash = {
						collectPageMetadata: runtime.collectPageMetadata.bind(runtime),
						collectPageFragments: runtime.collectPageFragments.bind(runtime),
					} as EmDashHandlers;
				} catch {
					// Non-fatal — EmDashHead will fall back to base SEO contributions
				}
				timings.push({ name: "rt", dur: performance.now() - t0, desc: "Runtime init" });
				// Append cold-only sub-phase timings so the breakdown is visible
				// in Server-Timing (rt.db, rt.fts, rt.plugins, rt.site,
				// rt.sandbox, rt.market, rt.hooks, rt.cron).
				for (const sub of initSubTimings) timings.push(sub);
			}

			// Even on the anonymous fast path we ask the adapter for a per-request
			// scoped db. For D1 with read replication this routes anonymous reads
			// to the nearest replica; for other adapters it's a no-op.
			const anonScoped = createRequestScopedDb({
				config: config?.database?.config,
				isAuthenticated: false,
				isWrite: request.method !== "GET" && request.method !== "HEAD",
				cookies,
				url,
			});
			const runAnon = async () => {
				const t0 = performance.now();
				const response = await next();
				timings.push({ name: "render", dur: performance.now() - t0, desc: "Page render" });
				timings.push({ name: "mw", dur: performance.now() - mwStart, desc: "Total middleware" });
				return finalizeResponse(response, timings);
			};
			if (anonScoped) {
				const parent = getRequestContext();
				const ctx = parent
					? { ...parent, db: anonScoped.db }
					: { editMode: false, db: anonScoped.db };
				return runWithContext(ctx, async () => {
					const response = await runAnon();
					anonScoped.commit();
					return response;
				});
			}
			return runAnon();
		}
	}

	const config = getConfig();
	if (!config) {
		console.error("EmDash: No configuration found");
		return finalizeResponse(await next());
	}

	// In playground mode, wrap the entire runtime init + request handling in
	// runWithContext so that getDatabase() and all init queries use the real
	// DO database via the same AsyncLocalStorage instance as the loader.
	const doInit = async () => {
		const timings: Array<{ name: string; dur: number; desc?: string }> = [];
		const mwStart = performance.now();

		try {
			// Get or create runtime. Sub-phase timings (rt.db, rt.fts, rt.plugins,
			// rt.site, rt.sandbox, rt.market, rt.hooks, rt.cron) are populated
			// only on the cold init — subsequent warm calls find the cached
			// instance and `initSubTimings` stays empty.
			const initSubTimings: Array<{ name: string; dur: number; desc?: string }> = [];
			let t0 = performance.now();
			const runtime = await getRuntime(config, initSubTimings);
			timings.push({ name: "rt", dur: performance.now() - t0, desc: "Runtime init" });
			// Forward any sub-phase samples so cold-start breakdown is visible
			// in Server-Timing. Each phase appears prefixed "rt." to distinguish
			// from the aggregate "rt" timing above.
			for (const sub of initSubTimings) timings.push(sub);

			// Runtime init runs migrations, so the DB is guaranteed set up
			setupVerified = true;

			// Get manifest (cached after first call)
			t0 = performance.now();
			const manifest = await runtime.getManifest();
			timings.push({ name: "manifest", dur: performance.now() - t0, desc: "Manifest" });

			// Attach to locals for route handlers
			locals.emdashManifest = manifest;
			locals.emdash = {
				// Content handlers
				handleContentList: runtime.handleContentList.bind(runtime),
				handleContentGet: runtime.handleContentGet.bind(runtime),
				handleContentCreate: runtime.handleContentCreate.bind(runtime),
				handleContentUpdate: runtime.handleContentUpdate.bind(runtime),
				handleContentDelete: runtime.handleContentDelete.bind(runtime),

				// Trash handlers
				handleContentListTrashed: runtime.handleContentListTrashed.bind(runtime),
				handleContentRestore: runtime.handleContentRestore.bind(runtime),
				handleContentPermanentDelete: runtime.handleContentPermanentDelete.bind(runtime),
				handleContentCountTrashed: runtime.handleContentCountTrashed.bind(runtime),
				handleContentGetIncludingTrashed: runtime.handleContentGetIncludingTrashed.bind(runtime),

				// Duplicate handler
				handleContentDuplicate: runtime.handleContentDuplicate.bind(runtime),

				// Publishing & Scheduling handlers
				handleContentPublish: runtime.handleContentPublish.bind(runtime),
				handleContentUnpublish: runtime.handleContentUnpublish.bind(runtime),
				handleContentSchedule: runtime.handleContentSchedule.bind(runtime),
				handleContentUnschedule: runtime.handleContentUnschedule.bind(runtime),
				handleContentCountScheduled: runtime.handleContentCountScheduled.bind(runtime),
				handleContentDiscardDraft: runtime.handleContentDiscardDraft.bind(runtime),
				handleContentCompare: runtime.handleContentCompare.bind(runtime),
				handleContentTranslations: runtime.handleContentTranslations.bind(runtime),

				// Media handlers
				handleMediaList: runtime.handleMediaList.bind(runtime),
				handleMediaGet: runtime.handleMediaGet.bind(runtime),
				handleMediaCreate: runtime.handleMediaCreate.bind(runtime),
				handleMediaUpdate: runtime.handleMediaUpdate.bind(runtime),
				handleMediaDelete: runtime.handleMediaDelete.bind(runtime),

				// Revision handlers
				handleRevisionList: runtime.handleRevisionList.bind(runtime),
				handleRevisionGet: runtime.handleRevisionGet.bind(runtime),
				handleRevisionRestore: runtime.handleRevisionRestore.bind(runtime),

				// Plugin routes
				handlePluginApiRoute: runtime.handlePluginApiRoute.bind(runtime),
				getPluginRouteMeta: runtime.getPluginRouteMeta.bind(runtime),

				// Media provider methods
				getMediaProvider: runtime.getMediaProvider.bind(runtime),
				getMediaProviderList: runtime.getMediaProviderList.bind(runtime),

				// Page contribution methods (for EmDashHead/EmDashBodyStart/EmDashBodyEnd)
				collectPageMetadata: runtime.collectPageMetadata.bind(runtime),
				collectPageFragments: runtime.collectPageFragments.bind(runtime),

				// Lazy search index health check — search endpoints call this
				// before querying so a crash-corrupted index gets repaired on
				// first use rather than stalling every cold start.
				ensureSearchHealthy: runtime.ensureSearchHealthy.bind(runtime),

				// Direct access (for advanced use cases)
				storage: runtime.storage,
				db: runtime.db,
				hooks: runtime.hooks,
				email: runtime.email,
				configuredPlugins: runtime.configuredPlugins,

				// Configuration (for checking database type, auth mode, etc.)
				config,

				// Manifest invalidation (call after schema changes)
				invalidateManifest: runtime.invalidateManifest.bind(runtime),

				// Sandbox runner (for marketplace plugin install/update)
				getSandboxRunner: runtime.getSandboxRunner.bind(runtime),

				// Sync marketplace plugin states (after install/update/uninstall)
				syncMarketplacePlugins: runtime.syncMarketplacePlugins.bind(runtime),

				// Update plugin enabled/disabled status and rebuild hook pipeline
				setPluginStatus: runtime.setPluginStatus.bind(runtime),
			};
		} catch (error) {
			console.error("EmDash middleware error:", error);
		}

		// Ask the adapter for a request-scoped db. When it returns one, we stash
		// it in ALS so the runtime's db getter and loader's getDb() pick it up,
		// then call commit() after next() so the adapter can persist any
		// per-request state (e.g. a D1 bookmark cookie for read-your-writes).
		const scoped = createRequestScopedDb({
			config: config?.database?.config,
			isAuthenticated: !!sessionUser,
			isWrite: request.method !== "GET" && request.method !== "HEAD",
			cookies: context.cookies,
			url,
		});

		const renderAndFinalize = async () => {
			const t0 = performance.now();
			const response = await next();
			timings.push({ name: "render", dur: performance.now() - t0, desc: "Page render" });
			timings.push({ name: "mw", dur: performance.now() - mwStart, desc: "Total middleware" });
			return finalizeResponse(response, timings);
		};

		if (scoped) {
			const parent = getRequestContext();
			const ctx = parent ? { ...parent, db: scoped.db } : { editMode: false, db: scoped.db };
			return runWithContext(ctx, async () => {
				const response = await renderAndFinalize();
				scoped.commit();
				return response;
			});
		}

		return renderAndFinalize();
	}; // end doInit

	if (playgroundDb) {
		// Read the edit-mode cookie to determine if visual editing is active.
		// Default to false -- editing is opt-in via the playground toolbar toggle.
		const editMode = context.cookies.get("emdash-edit-mode")?.value === "true";
		// Playground DBs are per-session isolated instances whose schema is
		// independent of the configured one — flag as isolated so schema-
		// derived caches (manifest, taxonomy defs) rebuild against it.
		return runWithContext({ editMode, db: playgroundDb, dbIsIsolated: true }, doInit);
	}
	return doInit();
});

export default onRequest;
