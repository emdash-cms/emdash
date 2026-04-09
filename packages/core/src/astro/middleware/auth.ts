/**
 * Auth middleware for admin routes
 *
 * Checks if the user is authenticated and has appropriate permissions.
 * Supports two auth modes:
 * - Passkey (default): Session-based auth with passkey login
 * - External providers: JWT-based auth (Cloudflare Access, etc.)
 *
 * This middleware runs AFTER the setup middleware - so if we get here,
 * we know setup is complete and users exist.
 */

import type { User, RoleLevel } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import { defineMiddleware } from "astro:middleware";
import { ulid } from "ulidx";
// Import auth provider via virtual module (statically bundled)
// This avoids dynamic import issues in Cloudflare Workers
import { authenticate as virtualAuthenticate } from "virtual:emdash/auth";

import { checkPublicCsrf } from "../../api/csrf.js";
import { apiError } from "../../api/error.js";
import { getPublicOrigin } from "../../api/public-url.js";

/** Cache headers for middleware error responses (matches API_CACHE_HEADERS in api/error.ts) */
const MW_CACHE_HEADERS = {
	"Cache-Control": "private, no-store",
} as const;
import { resolveApiToken, resolveOAuthToken } from "../../api/handlers/api-tokens.js";
import { hasScope } from "../../auth/api-tokens.js";
import { getAuthMode, type ExternalAuthMode } from "../../auth/mode.js";
import type { ExternalAuthConfig } from "../../auth/types.js";
import type { EmDashHandlers, EmDashManifest } from "../types.js";
import { buildEmDashCsp } from "./csp.js";

declare global {
	namespace App {
		interface Locals {
			user?: User;
			/** Token scopes when authenticated via API token or OAuth token. Undefined for session auth. */
			tokenScopes?: string[];
			emdash?: EmDashHandlers;
			emdashManifest?: EmDashManifest;
		}
		interface SessionData {
			user: { id: string };
			hasSeenWelcome: boolean;
		}
	}
}

// Role level constants (matching @emdash-cms/auth)
const ROLE_ADMIN = 50;
const MCP_ENDPOINT_PATH = "/_emdash/api/mcp";

function isUnsafeMethod(method: string): boolean {
	return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function csrfRejectedResponse(): Response {
	return new Response(
		JSON.stringify({ error: { code: "CSRF_REJECTED", message: "Missing required header" } }),
		{
			status: 403,
			headers: { "Content-Type": "application/json", ...MW_CACHE_HEADERS },
		},
	);
}

function mcpUnauthorizedResponse(url: URL): Response {
	return Response.json(
		{ error: { code: "NOT_AUTHENTICATED", message: "Not authenticated" } },
		{
			status: 401,
			headers: {
				"WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
				...MW_CACHE_HEADERS,
			},
		},
	);
}

/**
 * API routes that skip auth — each handles its own access control.
 *
 * Prefix entries match any path starting with that prefix.
 * Exact entries (no trailing slash or wildcard) match that path only.
 */
const PUBLIC_API_PREFIXES = [
	"/_emdash/api/setup",
	"/_emdash/api/auth/login",
	"/_emdash/api/auth/register",
	"/_emdash/api/auth/dev-bypass",
	"/_emdash/api/auth/signup/",
	"/_emdash/api/auth/magic-link/",
	"/_emdash/api/auth/invite/accept",
	"/_emdash/api/auth/invite/complete",
	"/_emdash/api/auth/oauth/",
	"/_emdash/api/oauth/device/token",
	"/_emdash/api/oauth/device/code",
	"/_emdash/api/oauth/token",
	"/_emdash/api/comments/",
	"/_emdash/api/media/file/",
	"/_emdash/.well-known/",
];

const PUBLIC_API_EXACT = new Set([
	"/_emdash/api/auth/passkey/options",
	"/_emdash/api/auth/passkey/verify",
	"/_emdash/api/oauth/token",
	"/_emdash/api/snapshot",
	// Public site search — read-only. The query layer hardcodes status='published'
	// so unauthenticated callers only see published content. Admin endpoints
	// (/enable, /rebuild, /stats) remain private because they're not in this set.
	"/_emdash/api/search",
]);

function isPublicEmDashRoute(pathname: string): boolean {
	if (PUBLIC_API_EXACT.has(pathname)) return true;
	if (PUBLIC_API_PREFIXES.some((p) => pathname.startsWith(p))) return true;
	if (import.meta.env.DEV && pathname === "/_emdash/api/typegen") return true;
	return false;
}

export const onRequest = defineMiddleware(async (context, next) => {
	const { url } = context;

	// Only check auth on admin routes and API routes
	const isAdminRoute = url.pathname.startsWith("/_emdash/admin");
	const isSetupRoute = url.pathname.startsWith("/_emdash/admin/setup");
	const isApiRoute = url.pathname.startsWith("/_emdash/api");
	const isPublicApiRoute = isPublicEmDashRoute(url.pathname);

	const isPublicRoute = !isAdminRoute && !isApiRoute;

	// Public API routes skip auth but still need CSRF protection on state-changing methods.
	// We check Origin header against the request host (same approach as Astro's checkOrigin).
	// This prevents cross-origin form submissions and fetch requests from malicious sites.
	if (isPublicApiRoute) {
		const method = context.request.method.toUpperCase();
		if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
			const publicOrigin = getPublicOrigin(url, context.locals.emdash?.config);
			const csrfError = checkPublicCsrf(context.request, url, publicOrigin);
			if (csrfError) return csrfError;
		}
		return next();
	}

	// Plugin routes: soft auth (resolve user if credentials present, but never block).
	// The catch-all handler decides per-route whether auth is required (public vs private).
	// Public plugin routes that accept POST are vulnerable to cross-origin form submissions,
	// so we apply the same Origin-based CSRF check as other public routes.
	const isPluginRoute = url.pathname.startsWith("/_emdash/api/plugins/");
	if (isPluginRoute) {
		const method = context.request.method.toUpperCase();
		if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
			const publicOrigin = getPublicOrigin(url, context.locals.emdash?.config);
			const csrfError = checkPublicCsrf(context.request, url, publicOrigin);
			if (csrfError) return csrfError;
		}
		return handlePluginRouteAuth(context, next);
	}

	// Setup routes: skip auth but still enforce CSRF on state-changing methods
	if (isSetupRoute) {
		const method = context.request.method.toUpperCase();
		if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
			const csrfHeader = context.request.headers.get("X-EmDash-Request");
			if (csrfHeader !== "1") {
				return new Response(
					JSON.stringify({
						error: { code: "CSRF_REJECTED", message: "Missing required header" },
					}),
					{
						status: 403,
						headers: { "Content-Type": "application/json", ...MW_CACHE_HEADERS },
					},
				);
			}
		}
		return next();
	}

	// For public routes: soft auth check (set locals.user if session exists, but never block)
	if (isPublicRoute) {
		return handlePublicRouteAuth(context, next);
	}

	// --- Everything below is /_emdash (admin + API) ---

	// Try Bearer token auth first (API tokens and OAuth tokens).
	// If successful, skip CSRF (tokens aren't ambient credentials like cookies).
	const bearerResult = await handleBearerAuth(context);

	if (bearerResult === "invalid") {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...MW_CACHE_HEADERS,
		};
		// Add WWW-Authenticate header on MCP endpoint 401s to trigger OAuth discovery
		if (url.pathname === "/_emdash/api/mcp") {
			const origin = getPublicOrigin(url, context.locals.emdash?.config);
			headers["WWW-Authenticate"] =
				`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
		}
		return new Response(
			JSON.stringify({ error: { code: "INVALID_TOKEN", message: "Invalid or expired token" } }),
			{ status: 401, headers },
		);
	}

	const isTokenAuth = bearerResult === "authenticated";

	// CSRF protection: require X-EmDash-Request header on state-changing requests.
	// Skip for token-authenticated requests (tokens aren't ambient credentials).
	// Browsers block cross-origin custom headers, so this prevents CSRF without tokens.
	// OAuth authorize consent is exempt: it's a standard HTML form POST that can't
	// include custom headers. The consent flow is protected by session + single-use codes.
	const method = context.request.method.toUpperCase();
	const isOAuthConsent = url.pathname.startsWith("/_emdash/oauth/authorize");
	const isMcpEndpoint = url.pathname === MCP_ENDPOINT_PATH;
	if (
		isApiRoute &&
		!isTokenAuth &&
		!isOAuthConsent &&
		!isMcpEndpoint &&
		isUnsafeMethod(method) &&
		!isPublicApiRoute
	) {
		const csrfHeader = context.request.headers.get("X-EmDash-Request");
		if (csrfHeader !== "1") {
			return csrfRejectedResponse();
		}
	}

	// If already authenticated via Bearer token, enforce scope then skip session/external auth
	if (isTokenAuth) {
		// Enforce API token scopes based on URL pattern + HTTP method
		const scopeError = enforceTokenScope(url.pathname, method, context.locals.tokenScopes);
		if (scopeError) return scopeError;

		const response = await next();
		if (!import.meta.env.DEV) {
			response.headers.set("Content-Security-Policy", buildEmDashCsp());
		}
		return response;
	}

	const response = await handleEmDashAuth(context, next);

	// Set strict CSP on all /_emdash responses (prod only)
	if (!import.meta.env.DEV) {
		response.headers.set("Content-Security-Policy", buildEmDashCsp());
	}

	return response;
});

/**
 * Auth handling for /_emdash routes. Returns a Response from either
 * an auth error/redirect or the downstream route handler.
 */
async function handleEmDashAuth(
	context: Parameters<Parameters<typeof defineMiddleware>[0]>[0],
	next: Parameters<Parameters<typeof defineMiddleware>[0]>[1],
): Promise<Response> {
	const { url, locals } = context;
	const { emdash } = locals;

	const isLoginRoute = url.pathname.startsWith("/_emdash/admin/login");
	const isApiRoute = url.pathname.startsWith("/_emdash/api");

	if (!emdash?.db) {
		// No database - let the admin handle this error
		return next();
	}

	// Determine auth mode from config
	const authMode = getAuthMode(emdash.config);

	if (authMode.type === "external") {
		// In dev mode, fall back to passkey auth since external JWT won't be present
		if (import.meta.env.DEV) {
			if (isLoginRoute) {
				return next();
			}

			return handlePasskeyAuth(context, next, isApiRoute);
		}

		// External auth provider (Cloudflare Access, etc.)
		return handleExternalAuth(context, next, authMode, isApiRoute);
	}

	// Passkey authentication (default)
	if (isLoginRoute) {
		return next();
	}

	return handlePasskeyAuth(context, next, isApiRoute);
}

/**
 * Soft auth for plugin routes: resolve user from Bearer token or session if present,
 * but never block unauthenticated requests. The catch-all handler checks route
 * metadata to decide whether auth is required (public vs private routes).
 */
async function handlePluginRouteAuth(
	context: Parameters<Parameters<typeof defineMiddleware>[0]>[0],
	next: Parameters<Parameters<typeof defineMiddleware>[0]>[1],
): Promise<Response> {
	const { locals } = context;
	const { emdash } = locals;

	try {
		// Try Bearer token auth first (API tokens and OAuth tokens)
		const bearerResult = await handleBearerAuth(context);
		if (bearerResult === "authenticated") {
			// User and tokenScopes are set on locals by handleBearerAuth
			return next();
		}
		if (bearerResult === "invalid") {
			// A token was presented but is invalid/expired — return 401 so the
			// caller knows their token is bad (don't silently downgrade to no-auth).
			return new Response(
				JSON.stringify({ error: { code: "INVALID_TOKEN", message: "Invalid or expired token" } }),
				{
					status: 401,
					headers: { "Content-Type": "application/json", ...MW_CACHE_HEADERS },
				},
			);
		}
		// "none" — no token presented, try session auth below.
	} catch (error) {
		console.error("Plugin route bearer auth error:", error);
	}

	try {
		// Try session auth (sets locals.user if session exists)
		const { session } = context;
		const sessionUser = await session?.get("user");
		if (sessionUser?.id && emdash?.db) {
			const adapter = createKyselyAdapter(emdash.db);
			const user = await adapter.getUserById(sessionUser.id);
			if (user && !user.disabled) {
				locals.user = user;
			}
		}
	} catch (error) {
		// Log but don't block — public routes should still work without session
		console.error("Plugin route session auth error:", error);
	}

	return next();
}

/**
 * Soft auth check for public routes with edit mode cookie.
 * Checks the session and sets locals.user if valid, but never blocks the request.
 */
async function handlePublicRouteAuth(
	context: Parameters<Parameters<typeof defineMiddleware>[0]>[0],
	next: Parameters<Parameters<typeof defineMiddleware>[0]>[1],
): Promise<Response> {
	const { locals, session } = context;
	const { emdash } = locals;

	try {
		const sessionUser = await session?.get("user");
		if (sessionUser?.id && emdash?.db) {
			const adapter = createKyselyAdapter(emdash.db);
			const user = await adapter.getUserById(sessionUser.id);
			if (user && !user.disabled) {
				locals.user = user;
			}
		}
	} catch {
		// Silently continue — public page should render normally
	}

	return next();
}

/**
 * Handle external auth provider authentication (Cloudflare Access, etc.)
 */
async function handleExternalAuth(
	context: Parameters<Parameters<typeof defineMiddleware>[0]>[0],
	next: Parameters<Parameters<typeof defineMiddleware>[0]>[1],
	authMode: ExternalAuthMode,
	_isApiRoute: boolean,
): Promise<Response> {
	const { locals, request } = context;
	const { emdash } = locals;

	try {
		// Use the authenticate function from the virtual module
		// (statically imported at build time to work with Cloudflare Workers)
		if (typeof virtualAuthenticate !== "function") {
			throw new Error(
				`Auth provider ${authMode.entrypoint} does not export an authenticate function`,
			);
		}

		// Authenticate via the provider
		const authResult = await virtualAuthenticate(request, authMode.config);

		// Get external auth config for auto-provision settings
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- narrowing AuthModeConfig to ExternalAuthConfig after provider check
		const externalConfig = authMode.config as ExternalAuthConfig;

		// Find or create user
		const adapter = createKyselyAdapter(emdash!.db);
		let user = await adapter.getUserByEmail(authResult.email);

		if (!user) {
			// User doesn't exist
			if (externalConfig.autoProvision === false) {
				return new Response("User not authorized", {
					status: 403,
					headers: { "Content-Type": "text/plain", ...MW_CACHE_HEADERS },
				});
			}

			// Check if this is the first user (they become admin)
			const userCount = await emdash!.db
				.selectFrom("users")
				.select(emdash!.db.fn.count("id").as("count"))
				.executeTakeFirst();

			const isFirstUser = Number(userCount?.count ?? 0) === 0;
			const role = isFirstUser ? ROLE_ADMIN : authResult.role;

			// Create user
			const now = new Date().toISOString();
			const newUser = {
				id: ulid(),
				email: authResult.email,
				name: authResult.name,
				role,
				email_verified: 1,
				created_at: now,
				updated_at: now,
			};

			await emdash!.db.insertInto("users").values(newUser).execute();

			user = await adapter.getUserByEmail(authResult.email);

			console.log(
				`[external-auth] Provisioned user: ${authResult.email} (role: ${role}, first: ${isFirstUser})`,
			);
		} else {
			// User exists - check if we need to sync anything
			const updates: Record<string, unknown> = {};
			let newName: string | undefined;
			let newRole: RoleLevel | undefined;

			// Sync name from provider if provider provides one and local differs
			if (authResult.name && user.name !== authResult.name) {
				newName = authResult.name;
				updates.name = newName;
			}

			// Sync role if enabled
			if (externalConfig.syncRoles && user.role !== authResult.role) {
				newRole = authResult.role;
				updates.role = newRole;
			}

			if (Object.keys(updates).length > 0) {
				updates.updated_at = new Date().toISOString();
				await emdash!.db.updateTable("users").set(updates).where("id", "=", user.id).execute();

				user = {
					...user,
					...(newName ? { name: newName } : {}),
					...(newRole ? { role: newRole } : {}),
				};

				console.log(
					`[external-auth] Updated user ${authResult.email}:`,
					Object.keys(updates).filter((k) => k !== "updated_at"),
				);
			}
		}

		if (!user) {
			// This shouldn't happen, but handle it gracefully
			return new Response("Failed to provision user", {
				status: 500,
				headers: { "Content-Type": "text/plain", ...MW_CACHE_HEADERS },
			});
		}

		// Check if user is disabled locally
		if (user.disabled) {
			return new Response("Account disabled", {
				status: 403,
				headers: { "Content-Type": "text/plain", ...MW_CACHE_HEADERS },
			});
		}

		// Set user in locals
		locals.user = user;

		// Persist to session so public pages can identify the user
		// (external auth headers are only verified on /_emdash routes)
		const { session } = context;
		session?.set("user", { id: user.id });

		return next();
	} catch (error) {
		console.error("[external-auth] Auth error:", error);

		return new Response("Authentication failed", {
			status: 401,
			headers: { "Content-Type": "text/plain", ...MW_CACHE_HEADERS },
		});
	}
}

/**
 * Try to authenticate via Bearer token (API token or OAuth token).
 *
 * Returns:
 * - "authenticated" if token is valid and user is resolved
 * - "invalid" if a token was provided but is invalid/expired
 * - "none" if no Bearer token was provided
 */
async function handleBearerAuth(
	context: Parameters<Parameters<typeof defineMiddleware>[0]>[0],
): Promise<"authenticated" | "invalid" | "none"> {
	const authHeader = context.request.headers.get("Authorization");
	if (!authHeader?.startsWith("Bearer ")) return "none";

	const token = authHeader.slice(7);
	if (!token) return "none";

	const { locals } = context;
	const { emdash } = locals;
	if (!emdash?.db) return "none";

	// Resolve token based on prefix
	let resolved: { userId: string; scopes: string[] } | null = null;

	if (token.startsWith("ec_pat_")) {
		resolved = await resolveApiToken(emdash.db, token);
	} else if (token.startsWith("ec_oat_")) {
		resolved = await resolveOAuthToken(emdash.db, token);
	} else {
		// Unknown token format
		return "invalid";
	}

	if (!resolved) return "invalid";

	// Look up the user
	const adapter = createKyselyAdapter(emdash.db);
	const user = await adapter.getUserById(resolved.userId);

	if (!user || user.disabled) return "invalid";

	// Set user and scopes on locals
	locals.user = user;
	locals.tokenScopes = resolved.scopes;

	return "authenticated";
}

/**
 * Handle passkey (session-based) authentication
 */
async function handlePasskeyAuth(
	context: Parameters<Parameters<typeof defineMiddleware>[0]>[0],
	next: Parameters<Parameters<typeof defineMiddleware>[0]>[1],
	isApiRoute: boolean,
): Promise<Response> {
	const { url, locals, request, session } = context;
	const { emdash } = locals;
	const isMcpEndpoint = url.pathname === MCP_ENDPOINT_PATH;
	const method = request.method.toUpperCase();

	try {
		// Check session for user (session.get returns a Promise)
		const sessionUser = await session?.get("user");

		if (!sessionUser?.id) {
			// Not authenticated
			if (isMcpEndpoint) {
				return mcpUnauthorizedResponse(url);
			}
			if (isApiRoute) {
				return Response.json(
					{ error: { code: "NOT_AUTHENTICATED", message: "Not authenticated" } },
					{ status: 401, headers: MW_CACHE_HEADERS },
				);
			}
			const loginUrl = new URL("/_emdash/admin/login", getPublicOrigin(url, emdash?.config));
			loginUrl.searchParams.set("redirect", url.pathname);
			return context.redirect(loginUrl.toString());
		}

		if (isMcpEndpoint && isUnsafeMethod(method)) {
			const csrfHeader = request.headers.get("X-EmDash-Request");
			if (csrfHeader !== "1") {
				return csrfRejectedResponse();
			}
		}

		// Get full user from database
		const adapter = createKyselyAdapter(emdash!.db);
		const user = await adapter.getUserById(sessionUser.id);

		if (!user) {
			// User no longer exists - clear session
			session?.destroy();
			if (isApiRoute) {
				return Response.json(
					{ error: { code: "NOT_FOUND", message: "User not found" } },
					{ status: 401, headers: MW_CACHE_HEADERS },
				);
			}
			const loginUrl = new URL("/_emdash/admin/login", getPublicOrigin(url, emdash?.config));
			return context.redirect(loginUrl.toString());
		}

		// Check if user is disabled
		if (user.disabled) {
			session?.destroy();
			if (isApiRoute) {
				return apiError("ACCOUNT_DISABLED", "Account disabled", 403);
			}
			const loginUrl = new URL("/_emdash/admin/login", getPublicOrigin(url, emdash?.config));
			loginUrl.searchParams.set("error", "account_disabled");
			return context.redirect(loginUrl.toString());
		}

		// Set user in locals for use by routes
		locals.user = user;
	} catch (error) {
		console.error("Auth middleware error:", error);
		// On error, redirect to login
		return context.redirect("/_emdash/admin/login");
	}

	return next();
}

// =============================================================================
// Token scope enforcement
// =============================================================================

/**
 * Scope rules: ordered list of (pathPrefix, method, requiredScope) tuples.
 * First matching rule wins. Methods: "*" = any, "WRITE" = POST/PUT/PATCH/DELETE.
 *
 * Routes not matched by any rule default to "admin" scope (fail-closed).
 */
const SCOPE_RULES: Array<[prefix: string, method: string, scope: string]> = [
	// Content routes
	["/_emdash/api/content", "GET", "content:read"],
	["/_emdash/api/content", "WRITE", "content:write"],

	// Media routes (excluding /file/ which is public)
	["/_emdash/api/media/file", "*", "media:read"], // public anyway, but scope if token-authed
	["/_emdash/api/media", "GET", "media:read"],
	["/_emdash/api/media", "WRITE", "media:write"],

	// Schema routes
	["/_emdash/api/schema", "GET", "schema:read"],
	["/_emdash/api/schema", "WRITE", "schema:write"],

	// Taxonomy, menu, section, widget, revision — all content domain
	["/_emdash/api/taxonomies", "GET", "content:read"],
	["/_emdash/api/taxonomies", "WRITE", "content:write"],
	["/_emdash/api/menus", "GET", "content:read"],
	["/_emdash/api/menus", "WRITE", "content:write"],
	["/_emdash/api/sections", "GET", "content:read"],
	["/_emdash/api/sections", "WRITE", "content:write"],
	["/_emdash/api/widget-areas", "GET", "content:read"],
	["/_emdash/api/widget-areas", "WRITE", "content:write"],
	["/_emdash/api/revisions", "GET", "content:read"],
	["/_emdash/api/revisions", "WRITE", "content:write"],

	// Search
	["/_emdash/api/search", "GET", "content:read"],
	["/_emdash/api/search", "WRITE", "admin"],

	// Import, admin, settings, plugins — all require admin scope
	["/_emdash/api/import", "*", "admin"],
	["/_emdash/api/admin", "*", "admin"],
	["/_emdash/api/settings", "*", "admin"],
	["/_emdash/api/plugins", "*", "admin"],

	// MCP endpoint — scopes enforced per-tool inside mcp/server.ts
	["/_emdash/api/mcp", "*", "content:read"],
];

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Enforce API token scopes based on the request URL and HTTP method.
 * Returns a 403 Response if the scope is insufficient, or null if allowed.
 *
 * Session-authenticated requests (tokenScopes === undefined) are never checked.
 */
function enforceTokenScope(
	pathname: string,
	method: string,
	tokenScopes: string[] | undefined,
): Response | null {
	// Session auth — implicit full access, no scope restrictions
	if (!tokenScopes) return null;

	const isWrite = WRITE_METHODS.has(method);

	for (const [prefix, ruleMethod, scope] of SCOPE_RULES) {
		// Match exact prefix or prefix followed by /
		if (pathname !== prefix && !pathname.startsWith(prefix + "/")) continue;

		// Check method match
		if (ruleMethod === "*" || (ruleMethod === "WRITE" && isWrite) || ruleMethod === method) {
			if (hasScope(tokenScopes, scope)) return null;

			return new Response(
				JSON.stringify({
					error: {
						code: "INSUFFICIENT_SCOPE",
						message: `Token lacks required scope: ${scope}`,
					},
				}),
				{ status: 403, headers: { "Content-Type": "application/json", ...MW_CACHE_HEADERS } },
			);
		}
	}

	// No rule matched — default to admin scope (fail-closed)
	if (hasScope(tokenScopes, "admin")) return null;

	return new Response(
		JSON.stringify({
			error: {
				code: "INSUFFICIENT_SCOPE",
				message: "Token lacks required scope: admin",
			},
		}),
		{ status: 403, headers: { "Content-Type": "application/json", ...MW_CACHE_HEADERS } },
	);
}
