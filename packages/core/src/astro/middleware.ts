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
	createCoalescingDialect as virtualCreateCoalescingDialect,
	createDialect as virtualCreateDialect,
	createRequestScopedDb as virtualCreateRequestScopedDb,
} from "virtual:emdash/dialect";
import type { RequestScopedDbOpts } from "virtual:emdash/dialect";
// @ts-ignore - virtual module
import { mediaProviders as virtualMediaProviders } from "virtual:emdash/media-providers";
// @ts-ignore - virtual module
import { plugins as virtualPlugins } from "virtual:emdash/plugins";
// @ts-ignore - virtual module
import * as virtualSandboxRunnerModule from "virtual:emdash/sandbox-runner";
// @ts-ignore - virtual module
import { sandboxedPlugins as virtualSandboxedPlugins } from "virtual:emdash/sandboxed-plugins";
// @ts-ignore - virtual module
import { createScheduler as virtualCreateScheduler } from "virtual:emdash/scheduler";
// @ts-ignore - virtual module
import { createStorage as virtualCreateStorage } from "virtual:emdash/storage";

import { after } from "../after.js";
import {
	createRecorder,
	flushRecorder,
	isInstrumentationEnabled,
} from "../database/instrumentation.js";
import {
	DB_INIT_DEADLINE_MS,
	EmDashRuntime,
	type RuntimeDependencies,
	type SandboxedPluginEntry,
	type MediaProviderEntry,
	type CreateSchedulerFn,
} from "../emdash-runtime.js";
import { setI18nConfig } from "../i18n/config.js";
import type { Database, Storage } from "../index.js";
import { createPublicMediaUrlResolver } from "../media/url.js";
import type { SandboxRunner } from "../plugins/sandbox/types.js";
import type { ResolvedPlugin } from "../plugins/types.js";
import { invalidateUrlPatternCache } from "../query.js";
import {
	createRequestMetrics,
	getRequestContext,
	type RequestMetrics,
	runWithContext,
} from "../request-context.js";
import type { PublishedRef } from "../scheduled-publish.js";
import { isMissingTableError } from "../utils/db-errors.js";
import { createInitLock, type InitLock, initWithLock } from "../utils/init-lock.js";
import type { EmDashConfig } from "./integration/runtime.js";
import { ASTRO_COOKIES_SYMBOL, finishScoped } from "./middleware/scoped-db.js";
import { wrapBodyForStreamMetrics } from "./middleware/stream-end-metrics.js";
import { prefetchLayoutData } from "./prefetch.js";
import { createPublicPluginApiRouteHandler } from "./public-plugin-api-routes.js";
import { resolveSessionUser } from "./session-user.js";
import type { EmDashHandlers } from "./types.js";

/**
 * Runtime init lock reclaim deadline. Must be strictly larger than the db
 * init deadline: this lock wraps EmDashRuntime.create() → getDatabase() →
 * the db init lock, and equal deadlines would let this outer lock reclaim
 * (spawning a second cron scheduler and sandbox runner) while the inner db
 * init is legitimately still working through a contended migration.
 */
const RUNTIME_INIT_DEADLINE_MS = DB_INIT_DEADLINE_MS + 15_000;

/**
 * Whether we've verified the database has been set up.
 * On a fresh deployment the first request may hit a public page, bypassing
 * runtime init. Without this check, template helpers like getSiteSettings()
 * would query an empty database and crash. Once verified (or once the runtime
 * has initialized via an admin/API request), this stays true for the worker's
 * lifetime.
 *
 * Stored on globalThis behind a Symbol key so the flag is a true singleton
 * even when the bundler duplicates this module across SSR chunks (same
 * pattern as request-cache.ts). A plain module-scoped `let` becomes multiple
 * independent variables, which would make the setup probe re-run far more
 * often than intended — and every re-run is another chance for a transient
 * DB error to be misread as "fresh install" and bounce visitors to setup.
 */
const SETUP_VERIFIED_KEY = Symbol.for("emdash:setup-verified");
const setupFlagStore = globalThis as Record<symbol, unknown>;

function isSetupVerified(): boolean {
	return setupFlagStore[SETUP_VERIFIED_KEY] === true;
}

function markSetupVerified(): void {
	setupFlagStore[SETUP_VERIFIED_KEY] = true;
}

/**
 * The runtime singleton and its init lock live on globalThis behind a
 * Symbol — same reasoning as SETUP_VERIFIED_KEY above: the bundler can
 * duplicate this module across SSR chunks, and a duplicated instance/lock
 * would mean multiple runtimes (each with its own cron scheduler) per
 * isolate, initializing and reclaiming independently.
 */
const RUNTIME_HOLDER_KEY = Symbol.for("emdash:runtime-holder");
interface RuntimeHolder {
	instance: EmDashRuntime | null;
	lock: InitLock;
}

function getRuntimeHolder(): RuntimeHolder {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis symbol slot, written only below
	let holder = setupFlagStore[RUNTIME_HOLDER_KEY] as RuntimeHolder | undefined;
	if (!holder) {
		holder = { instance: null, lock: createInitLock() };
		setupFlagStore[RUNTIME_HOLDER_KEY] = holder;
	}
	return holder;
}

/** Whether i18n config has been initialized from the virtual module */
let i18nInitialized = false;

/**
 * Get EmDash configuration from virtual module
 */
function getConfig(): EmDashConfig | null {
	if (virtualConfig && typeof virtualConfig === "object") {
		// Initialize i18n config on first access (once per worker lifetime)
		if (!i18nInitialized) {
			i18nInitialized = true;
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- virtual module checked as object above
			const config = virtualConfig as Record<string, unknown>;
			if (config.i18n && typeof config.i18n === "object") {
				setI18nConfig(
					// eslint-disable-next-line typescript/no-unsafe-type-assertion -- runtime-checked above
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

		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- virtual module import is untyped (@ts-ignore above)
		return virtualConfig as EmDashConfig;
	}
	return null;
}

/**
 * Get plugins from virtual module
 */
function getPlugins(): ResolvedPlugin[] {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- virtual module import is untyped (@ts-ignore above)
	return (virtualPlugins as ResolvedPlugin[]) || [];
}

/**
 * Build runtime dependencies from virtual modules
 */
function buildDependencies(config: EmDashConfig): RuntimeDependencies {
	/* eslint-disable typescript-eslint/no-unsafe-type-assertion --
	   The virtual:emdash/* imports above use @ts-ignore because tsgo/IDE
	   resolution can't see virtual-modules.d.ts in every consumer setup,
	   so they arrive as `any`. The casts here line each entry up with
	   RuntimeDependencies's expected shape. The contract is enforced by
	   the integration that populates these virtual modules. */
	const sandboxModule = virtualSandboxRunnerModule as Record<string, unknown>;
	return {
		config,
		plugins: getPlugins(),
		createDialect: virtualCreateDialect as (config: Record<string, unknown>) => unknown,
		// Optional: only batching backends (D1, DO) export this; undefined otherwise.
		createCoalescingDialect: virtualCreateCoalescingDialect as
			| ((config: Record<string, unknown>) => unknown)
			| undefined,
		createStorage: virtualCreateStorage as ((config: Record<string, unknown>) => Storage) | null,
		createScheduler: virtualCreateScheduler as CreateSchedulerFn | null,
		sandboxEnabled: sandboxModule.sandboxEnabled as boolean,
		sandboxBypassed: (sandboxModule.sandboxBypassed as boolean) ?? false,
		sandboxedPluginEntries: (virtualSandboxedPlugins as SandboxedPluginEntry[]) || [],
		createSandboxRunner: sandboxModule.createSandboxRunner as
			| ((opts: {
					db: Kysely<Database>;
					mediaStorage?: {
						upload(options: {
							key: string;
							body: Uint8Array;
							contentType: string;
						}): Promise<unknown>;
						delete(key: string): Promise<unknown>;
					};
			  }) => SandboxRunner)
			| null,
		mediaProviderEntries: (virtualMediaProviders as MediaProviderEntry[]) || [],
	};
	/* eslint-enable typescript-eslint/no-unsafe-type-assertion */
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
	// Waiters poll rather than awaiting the initializing request's promise —
	// workerd flags cross-request promise resolution (warnings + potential
	// hangs). If the initializing request is cancelled mid-create (client
	// disconnect tears down its continuation, skipping any `finally`), the
	// anchored init keeps running under waitUntil and populates the cache;
	// failing that, the stale lock is reclaimed after a deadline instead of
	// hanging every subsequent request in the isolate until eviction.
	const holder = getRuntimeHolder();
	return initWithLock(
		holder.lock,
		() => holder.instance,
		async (isCurrentClaim) => {
			const deps = buildDependencies(config);
			const runtime = await EmDashRuntime.create(deps, initTimings);
			if (isCurrentClaim()) {
				holder.instance = runtime;
			} else {
				// This init was reclaimed mid-flight (it ran past the deadline
				// and a waiter started its own). Don't overwrite the
				// reclaimer's published runtime, and stop this one's cron
				// scheduler so it doesn't keep firing unreferenced. The
				// runtime is still returned — it's fully functional for the
				// request that built it.
				runtime.stopCron().catch((error: unknown) => {
					console.error("[emdash] failed to stop superseded runtime's cron:", error);
				});
			}
			return runtime;
		},
		{
			deadlineMs: RUNTIME_INIT_DEADLINE_MS,
			anchor: (promise) => after(() => promise),
		},
	);
}

/**
 * Run scheduled maintenance (cron tasks, scheduled publishing, system cleanup)
 * outside any request. Resolves the runtime from the build-time virtual config
 * and the cached singleton — the same instance request handlers use.
 *
 * Wired into a platform heartbeat that is not a request: the Cloudflare Worker's
 * `scheduled()` handler (Cron Trigger) calls this. On Node the runtime's own
 * timer-based scheduler already drives the same work, so this isn't needed there.
 *
 * Returns the content promoted by the publishing sweep so the caller can purge
 * edge-cache tags for it. `onPublished` (optional) is awaited after each
 * collection's batch so the caller can invalidate edge-cache tags incrementally
 * rather than only after the whole sweep.
 */
export async function runScheduledTasks(
	options: { onPublished?: (refs: PublishedRef[]) => Promise<void> } = {},
): Promise<{ published: PublishedRef[] }> {
	const config = getConfig();
	if (!config) return { published: [] };
	const runtime = await getRuntime(config);

	// Connection-backed adapters (e.g. Postgres over Hyperdrive) cannot reuse
	// the per-isolate singleton from a Cron Trigger: its socket belongs to the
	// request that opened it, and workerd rejects cross-event I/O. Open an
	// event-scoped connection for the sweep and run the batch under it in ALS —
	// the runtime's db getter, the cron executor, and plugin cron contexts all
	// resolve the connection from ALS — then close it. Gated on the adapter
	// being connection-backed (it exposes `close()`); stateless adapters (D1,
	// Node SQLite) return null or a close-less scope and keep using the
	// singleton, so their cron path is unchanged.
	const scoped = createRequestScopedDb({
		config: config.database?.config,
		isAuthenticated: false,
		// The sweep publishes and cleans up — a write workload — so a
		// connection-backed adapter routes it to the primary.
		isWrite: true,
		cookies: NOOP_COOKIE_JAR,
		url: CRON_EVENT_URL,
	});
	if (!scoped?.close) {
		// Stateless adapter (or no per-request scoping): the singleton is safe
		// outside a request. Any close-less scope created above is discarded.
		return runtime.runScheduledTasks(options);
	}

	const parent = getRequestContext();
	const ctx = parent
		? { ...parent, db: scoped.db }
		: { editMode: false, db: scoped.db, metrics: createRequestMetrics(performance.now()) };
	try {
		return await runWithContext(ctx, () => runtime.runScheduledTasks(options));
	} finally {
		// Guard both so a throw in teardown can't mask the sweep result or skip
		// close() and leak the connection. Mirrors closeSafely() in scoped-db.ts.
		try {
			scoped.commit();
		} catch (error) {
			console.error("[scheduled] request-scoped db commit failed:", error);
		}
		try {
			scoped.close();
		} catch (error) {
			console.error("[scheduled] request-scoped db close failed:", error);
		}
	}
}

/**
 * A cookie jar that reads nothing and writes nothing, for request-scoped db
 * adapters invoked outside an HTTP request (the Cron Trigger sweep). Connection
 * adapters like Hyperdrive ignore cookies entirely; the D1 session adapter
 * reads/writes a bookmark cookie, but cron never reaches that path (it has no
 * `close()`), so the no-ops are never observed.
 */
const NOOP_COOKIE_JAR = {
	get: () => undefined,
	set: () => {},
};

/**
 * Synthetic URL for the cron sweep's request-scoped db opts. Only the D1
 * session adapter inspects `url` (for cookie `secure`), and cron doesn't take
 * that path, so the value is never used — it exists to satisfy the contract.
 */
const CRON_EVENT_URL = new URL("https://cron.emdash.internal/");

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

/**
 * Append always-on counters (db.*, cache.*) to the Server-Timing list.
 *
 * dur values for `count`, `hit`, `miss` are integer counts — Server-Timing
 * spec only models milliseconds, but browsers show whatever number is given,
 * which is the convention most projects use for non-time samples.
 */
function pushMetricsTimings(
	timings: Array<{ name: string; dur: number; desc?: string }>,
	metrics: RequestMetrics,
): void {
	if (metrics.dbCount > 0) {
		timings.push({ name: "db.total", dur: metrics.dbTotalMs, desc: "DB total" });
		timings.push({ name: "db.count", dur: metrics.dbCount, desc: "Query count" });
		if (metrics.dbFirstOffset !== null) {
			timings.push({ name: "db.first", dur: metrics.dbFirstOffset, desc: "First query at" });
		}
		if (metrics.dbLastOffset !== null) {
			timings.push({ name: "db.last", dur: metrics.dbLastOffset, desc: "Last query at" });
		}
	}
	if (metrics.rpcCount > 0) {
		timings.push({ name: "rpc.count", dur: metrics.rpcCount, desc: "DB round trips" });
	}
	if (metrics.cacheHits + metrics.cacheMisses > 0) {
		timings.push({ name: "cache.hit", dur: metrics.cacheHits, desc: "Cache hits" });
		timings.push({ name: "cache.miss", dur: metrics.cacheMisses, desc: "Cache misses" });
	}
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
): { db: Kysely<Database>; commit: () => void; close?: () => void } | null {
	if (typeof virtualCreateRequestScopedDb !== "function") return null;
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- adapter returns Kysely<unknown>; cast to Database since core owns that type
	const fn = virtualCreateRequestScopedDb as (
		o: RequestScopedDbOpts,
	) => { db: Kysely<Database>; commit: () => void; close?: () => void } | null;
	return fn(opts);
}

export const onRequest = defineMiddleware(async (context, next) => {
	const { request, locals, cookies } = context;
	const url = context.url;

	// Fast path: routes outside /_emdash/ that plugins inject (e.g.,
	// /.well-known/atproto-client-metadata.json) skip the entire runtime
	// init + middleware chain. External servers fetch these with tight
	// timeouts (~1-2s) so they must respond quickly even on cold starts.
	if (!url.pathname.startsWith("/_emdash") && virtualConfig?.authProviders) {
		const isPluginFastRoute = virtualConfig.authProviders.some(
			(p: { routes?: { pattern?: string }[] }) =>
				p.routes?.some((r: { pattern?: string }) => r.pattern && url.pathname === r.pattern),
		);
		if (isPluginFastRoute) {
			return finalizeResponse(await next());
		}
	}

	const queryRecorder = isInstrumentationEnabled()
		? createRecorder(url.pathname, request.method, request.headers.get("x-perf-phase") ?? "default")
		: undefined;

	const metrics = createRequestMetrics(performance.now());

	const run = async (): Promise<Response> => {
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
		// Skipped entirely for:
		//   - prerendered requests (no session at build time)
		//   - requests without an `astro-session` cookie (no session to look up)
		// The cookie check matters on Cloudflare Workers, where Astro's session
		// backend is KV: calling session.get() on every anonymous public request
		// turns normal traffic into a flood of KV read misses. See #733.
		const hasSessionCookie = cookies.get("astro-session") !== undefined;
		const sessionUser =
			context.isPrerendered || !hasSessionCookie ? null : await resolveSessionUser(context.session);

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
				// Skip the probe when prerendering: a prerendered route is built to
				// static HTML, so returning context.redirect("/_emdash/admin/setup")
				// below would bake that redirect into the page and ship it to
				// production. The build database is legitimately empty in CI and there
				// is no live visitor to send to the wizard at build time (session reads
				// are already skipped for prerender above for the same reason).
				if (!isSetupVerified() && !context.isPrerendered) {
					const t0 = performance.now();
					try {
						const { getDb } = await import("../loader.js");
						const db = await getDb();
						await db
							.selectFrom("_emdash_migrations" as keyof Database)
							.selectAll()
							.limit(1)
							.execute();
						markSetupVerified();
					} catch (error) {
						// Only a genuinely-missing migrations table means a fresh,
						// un-set-up database — redirect to the setup wizard.
						if (isMissingTableError(error)) {
							return context.redirect("/_emdash/admin/setup");
						}
						// Any other failure (transient D1/replica error, timeout, cold-start
						// race, locked SQLite) must NOT be read as "fresh install" — doing so
						// bounces real visitors on a set-up site to /_emdash/admin/setup.
						// Leave the flag unset so a later request can re-verify, and fall
						// through to render the page normally.
						console.error("Setup probe failed (non-fatal):", error);
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
						markSetupVerified();
						const handlePublicPluginApiRoute = createPublicPluginApiRouteHandler(runtime);
						// eslint-disable-next-line typescript/no-unsafe-type-assertion -- partial object; getPageRuntime() only checks for the page-contribution methods
						locals.emdash = {
							handlePublicPluginApiRoute,
							collectPageMetadata: runtime.collectPageMetadata.bind(runtime),
							collectPageFragments: runtime.collectPageFragments.bind(runtime),
							getPublicMediaUrl: createPublicMediaUrlResolver(runtime.storage),
							// Exposed so the wrapped image endpoint (`/_image`) can read media
							// bytes from storage on the anonymous fast path -- public `<img>`
							// requests carry no session.
							storage: runtime.storage,
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
					pushMetricsTimings(timings, metrics);
					// Server-Timing only sees pre-stream queries; the stream-end
					// wrapper (instrumentation-gated, no-op otherwise) emits the
					// final counters once the body finishes streaming.
					return wrapBodyForStreamMetrics(finalizeResponse(response, timings));
				};
				if (anonScoped) {
					const parent = getRequestContext();
					const ctx = parent
						? { ...parent, db: anonScoped.db }
						: { editMode: false, db: anonScoped.db, metrics };
					// Eagerly warm site-global layout data (menus, widget areas,
					// taxonomy terms, settings) concurrently so the layout's
					// per-component reads overlap into ~one wall-clock round trip and
					// hit a warm cache instead of serializing. Three guards:
					//  - request-scoped (remote) backend only -- this branch implies it;
					//    pointless on synchronous local SQLite.
					//  - HTML navigations only -- feeds/sitemaps/JSON don't render the
					//    layout, so prefetching their chrome is pure waste.
					//  - via after(): it runs immediately (still warms the render) but
					//    hands the promise to waitUntil, so the surplus warm-up (chrome a
					//    given page doesn't render) is kept alive past the response rather
					//    than erroring on workerd as orphaned request I/O.
					// Gate on the CLIENT'S PREFERRED type (leading media range), not a
					// substring -- browser navigations lead with `text/html`, while feed
					// readers lead with `application/rss+xml` etc. and only list
					// `text/html;q=0.8` later, so a substring match would leak onto feeds.
					const acceptsHtml = (request.headers.get("accept") ?? "")
						.split(",", 1)[0]!
						.trim()
						.startsWith("text/html");
					return runWithContext(ctx, async () => {
						if (acceptsHtml) after(() => prefetchLayoutData());
						// commit() persists per-request state (e.g. the D1 bookmark cookie)
						// before the response is returned, even if render throws; close()
						// (connection teardown) is deferred to stream-end. See finishScoped.
						return finishScoped(anonScoped, runAnon);
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
				markSetupVerified();

				// The manifest is no longer pre-loaded here. It's admin-only
				// content that public/anonymous requests never read, and
				// loading it on every request put logged-out hot paths on
				// the same staleness budget as admin operations. Admin
				// routes call `emdash.getManifest()` directly.

				// Attach to locals for route handlers
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
					handlePublicPluginApiRoute: createPublicPluginApiRouteHandler(runtime),
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
					// Lazy getter, not an eager snapshot: `locals.emdash` is built
					// before the per-request scoped db is installed in ALS, so reading
					// `runtime.db` here would capture the per-isolate singleton. Routes
					// access `emdash.db` later, during the request, when the scoped db
					// is active. For a stateless binding (D1) the two are equivalent,
					// but for a request-bound connection (pg/Hyperdrive) the singleton
					// belongs to the cold-start request and reusing it from a warm
					// request hangs on workerd's cross-request I/O guard.
					get db() {
						return runtime.db;
					},
					getPublicMediaUrl: createPublicMediaUrlResolver(runtime.storage),
					hooks: runtime.hooks,
					email: runtime.email,
					configuredPlugins: runtime.configuredPlugins,

					// Configuration (for checking database type, auth mode, etc.)
					config,

					// Lazy manifest accessor — admin-only consumers call this on
					// demand. `requestCached` inside `getManifest` dedupes within
					// a single request.
					getManifest: runtime.getManifest.bind(runtime),

					// Clear the URL pattern cache after schema mutations that
					// affect collection URL patterns.
					invalidateUrlPatternCache,

					// Sandbox runner (for marketplace plugin install/update)
					getSandboxRunner: runtime.getSandboxRunner.bind(runtime),
					isSandboxBypassed: runtime.isSandboxBypassed.bind(runtime),

					// Sync marketplace plugin states (after install/update/uninstall)
					syncMarketplacePlugins: runtime.syncMarketplacePlugins.bind(runtime),

					// Sync registry plugin states (after install/update/uninstall)
					syncRegistryPlugins: runtime.syncRegistryPlugins.bind(runtime),

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
				pushMetricsTimings(timings, metrics);
				// Server-Timing only sees pre-stream queries; the stream-end
				// wrapper (instrumentation-gated, no-op otherwise) emits the
				// final counters once the body finishes streaming.
				return wrapBodyForStreamMetrics(finalizeResponse(response, timings));
			};

			if (scoped) {
				const parent = getRequestContext();
				const ctx = parent
					? { ...parent, db: scoped.db }
					: { editMode: false, db: scoped.db, metrics };
				return runWithContext(ctx, () =>
					// commit() persists per-request state (e.g. the D1 bookmark cookie)
					// before the response returns, even if render throws; close()
					// (connection teardown) is deferred to stream-end. See finishScoped.
					finishScoped(scoped, renderAndFinalize),
				);
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
			const parent = getRequestContext();
			const ctx = parent
				? { ...parent, editMode, db: playgroundDb, dbIsIsolated: true }
				: { editMode, db: playgroundDb, dbIsIsolated: true, metrics };
			return runWithContext(ctx, doInit);
		}
		return doInit();
	};

	try {
		return await runWithContext({ editMode: false, queryRecorder, metrics }, run);
	} finally {
		// Streamed responses defer the flush to stream end (see
		// wrapBodyForStreamMetrics) so the log captures queries issued while
		// the body renders. Only flush here for responses that were not
		// wrapped (no body: redirects, 304s, bodyless errors), where all
		// queries have already run by the time middleware returns.
		if (queryRecorder && !queryRecorder.deferredFlush) flushRecorder(queryRecorder);
	}
});

export default onRequest;
