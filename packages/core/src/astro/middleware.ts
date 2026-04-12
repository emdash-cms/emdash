/**
 * EmDash middleware
 *
 * Thin wrapper that initializes EmDashRuntime and attaches it to locals.
 * All heavy lifting happens in EmDashRuntime.
 */

import { defineMiddleware } from "astro:middleware";
import { Kysely } from "kysely";
// Import from virtual modules (populated by integration at build time)
// @ts-ignore - virtual module
import virtualConfig from "virtual:emdash/config";
// @ts-ignore - virtual module
import {
	createDialect as virtualCreateDialect,
	isSessionEnabled as virtualIsSessionEnabled,
	getD1Binding as virtualGetD1Binding,
	getDefaultConstraint as virtualGetDefaultConstraint,
	getBookmarkCookieName as virtualGetBookmarkCookieName,
	createSessionDialect as virtualCreateSessionDialect,
} from "virtual:emdash/dialect";
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
import { runWithContext } from "../request-context.js";
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
 * Get or create the runtime instance
 */
async function getRuntime(config: EmDashConfig): Promise<EmDashRuntime> {
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
		return getRuntime(config);
	}

	runtimeInitializing = true;
	try {
		const deps = buildDependencies(config);
		const runtime = await EmDashRuntime.create(deps);
		runtimeInstance = runtime;
		return runtime;
	} finally {
		runtimeInitializing = false;
	}
}

/**
 * Baseline security headers applied to all responses.
 * Admin routes get additional headers (strict CSP) from auth middleware.
 */
function setBaselineSecurityHeaders(response: Response): void {
	// Prevent MIME type sniffing
	response.headers.set("X-Content-Type-Options", "nosniff");
	// Control referrer information
	response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
	// Restrict access to sensitive browser APIs
	response.headers.set(
		"Permissions-Policy",
		"camera=(), microphone=(), geolocation=(), payment=()",
	);
	// Prevent clickjacking (non-admin routes; admin CSP uses frame-ancestors)
	if (!response.headers.has("Content-Security-Policy")) {
		response.headers.set("X-Frame-Options", "SAMEORIGIN");
	}
}

/** Public routes that require the runtime (sitemap, robots.txt, etc.) */
const PUBLIC_RUNTIME_ROUTES = new Set(["/sitemap.xml", "/robots.txt"]);
const SITEMAP_COLLECTION_RE = /^\/sitemap-[a-z][a-z0-9_]*\.xml$/;

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

	if (!isEmDashRoute && !isPublicRuntimeRoute && !hasEditCookie && !hasPreviewToken) {
		const sessionUser = context.isPrerendered ? null : await context.session?.get("user");
		if (!sessionUser && !playgroundDb) {
			// On a fresh deployment the database may be completely empty.
			// Public pages call getSiteSettings() / getMenu() via getDb(), which
			// bypasses runtime init and would crash with "no such table: options".
			// Do a one-time lightweight probe using the same getDb() instance the
			// page will use: if the migrations table doesn't exist, no migrations
			// have ever run -- redirect to the setup wizard.
			if (!setupVerified) {
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
			}

			// Initialize the runtime for page:metadata and page:fragments hooks.
			// The runtime is a cached singleton — after the first request,
			// getRuntime() is just a null-check. This enables SEO plugins to
			// contribute meta tags for all visitors, not just logged-in editors.
			const config = getConfig();
			if (config) {
				try {
					const runtime = await getRuntime(config);
					setupVerified = true;
					// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- partial object; getPageRuntime() only checks for these two methods
					locals.emdash = {
						collectPageMetadata: runtime.collectPageMetadata.bind(runtime),
						collectPageFragments: runtime.collectPageFragments.bind(runtime),
					} as EmDashHandlers;
				} catch {
					// Non-fatal — EmDashHead will fall back to base SEO contributions
				}
			}

			const response = await next();
			setBaselineSecurityHeaders(response);
			return response;
		}
	}

	const config = getConfig();
	if (!config) {
		console.error("EmDash: No configuration found");
		return next();
	}

	// In playground mode, wrap the entire runtime init + request handling in
	// runWithContext so that getDatabase() and all init queries use the real
	// DO database via the same AsyncLocalStorage instance as the loader.
	const doInit = async () => {
		try {
			// Get or create runtime
			const runtime = await getRuntime(config);

			// Runtime init runs migrations, so the DB is guaranteed set up
			setupVerified = true;

			// Get manifest (cached after first call)
			const manifest = await runtime.getManifest();

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

		// =========================================================================
		// D1 Read Replica Session Management
		//
		// When D1 sessions are enabled, we create a per-request D1 session and
		// Kysely instance. The session is wrapped in ALS so `runtime.db` (a getter)
		// picks up the per-request instance instead of the singleton.
		//
		// After the response, we extract the bookmark from the session and set
		// it as a cookie for authenticated users (read-your-writes consistency).
		// =========================================================================
		const dbConfig = config?.database?.config;
		const sessionEnabled =
			dbConfig &&
			typeof virtualIsSessionEnabled === "function" &&
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- virtual module functions are untyped
			(virtualIsSessionEnabled as (config: unknown) => boolean)(dbConfig);

		if (
			sessionEnabled &&
			typeof virtualGetD1Binding === "function" &&
			virtualCreateSessionDialect
		) {
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- virtual module functions are untyped
			const d1Binding = (virtualGetD1Binding as (config: unknown) => unknown)(dbConfig);

			if (d1Binding && typeof d1Binding === "object" && "withSession" in d1Binding) {
				const isAuthenticated = context.isPrerendered
					? false
					: !!(await context.session?.get("user"));
				const isWrite = request.method !== "GET" && request.method !== "HEAD";

				// Determine session constraint:
				// - Config says "primary-first" → always "first-primary"
				// - Authenticated writes → "first-primary" (need to hit primary)
				// - Authenticated reads with bookmark → resume from bookmark
				// - Otherwise → "first-unconstrained" (nearest replica)
				// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- virtual module functions are untyped
				const configConstraint = (virtualGetDefaultConstraint as (config: unknown) => string)(
					dbConfig,
				);
				// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- virtual module functions are untyped
				const cookieName = (virtualGetBookmarkCookieName as (config: unknown) => string)(dbConfig);

				let constraint: string = configConstraint;
				if (isAuthenticated && isWrite) {
					constraint = "first-primary";
				} else if (isAuthenticated) {
					const bookmarkCookie = context.cookies.get(cookieName);
					if (bookmarkCookie?.value) {
						constraint = bookmarkCookie.value;
					}
				}

				// Create the D1 session and per-request Kysely instance.
				// D1DatabaseSession has the same prepare()/batch() interface as D1Database,
				// so createSessionDialect passes it straight to D1Dialect.
				// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- D1 binding with Sessions API, checked via "withSession" in d1Binding above
				const withSession = (d1Binding as { withSession: (c: string) => unknown }).withSession;
				const session = withSession.call(d1Binding, constraint);
				const sessionDialect =
					// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- virtual module functions are untyped
					(virtualCreateSessionDialect as (db: unknown) => import("kysely").Dialect)(session);
				const sessionDb = new Kysely<Database>({ dialect: sessionDialect });

				// Wrap the request in ALS with the per-request db
				return runWithContext({ editMode: false, db: sessionDb }, async () => {
					const response = await next();
					setBaselineSecurityHeaders(response);

					// Set bookmark cookie for authenticated users only — they need
					// read-your-writes consistency across requests. Anonymous visitors
					// don't write, so they get "first-unconstrained" every time.
					if (
						isAuthenticated &&
						session &&
						typeof session === "object" &&
						"getBookmark" in session
					) {
						// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- D1DatabaseSession with getBookmark()
						const getBookmark = (session as { getBookmark: () => string | null }).getBookmark;
						const newBookmark = getBookmark.call(session);
						if (newBookmark) {
							response.headers.append(
								"Set-Cookie",
								`${cookieName}=${newBookmark}; Path=/; HttpOnly; SameSite=Lax; Secure`,
							);
						}
					}

					return response;
				});
			}
		}

		const response = await next();
		setBaselineSecurityHeaders(response);
		return response;
	}; // end doInit

	if (playgroundDb) {
		// Read the edit-mode cookie to determine if visual editing is active.
		// Default to false -- editing is opt-in via the playground toolbar toggle.
		const editMode = context.cookies.get("emdash-edit-mode")?.value === "true";
		return runWithContext({ editMode, db: playgroundDb }, doInit);
	}
	return doInit();
});

export default onRequest;
