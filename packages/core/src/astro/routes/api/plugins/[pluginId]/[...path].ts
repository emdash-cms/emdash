/**
 * Plugin API routes - dynamic handler for plugin-defined endpoints
 *
 * Routes are mounted at /_emdash/api/plugins/{pluginId}/*
 * Plugins register routes like "POST /do-something" which becomes
 * POST /_emdash/api/plugins/{pluginId}/do-something
 *
 * Routes marked as `public: true` skip authentication and CSRF checks.
 * Private routes (the default) require authentication and appropriate permissions.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess } from "#api/error.js";
import { requireScope } from "#auth/scopes.js";

export const prerender = false;

/**
 * Handle all methods by matching against plugin-defined routes
 */
const handleRequest: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const pluginId = params.pluginId!;
	const path = params.path || "";
	const method = request.method.toUpperCase();

	if (!emdash?.handlePluginApiRoute) {
		return apiError("NOT_CONFIGURED", "EmDash not configured", 500);
	}

	// Resolve route metadata to decide auth before dispatch
	const routeMeta = emdash.getPluginRouteMeta(pluginId, `/${path}`);

	if (!routeMeta) {
		return apiError("NOT_FOUND", "Plugin route not found", 404);
	}

	// Public routes skip auth, CSRF, and scope checks entirely
	if (!routeMeta.public) {
		// Plugin routes are dispatched by name only — the HTTP method never
		// selects a different handler, so a route reached via GET or HEAD runs
		// exactly the same code (and side effects) as one reached via POST.
		// Method-based tiering is therefore unsafe: gating GET/HEAD/OPTIONS on
		// `plugins:read` with no CSRF let an editor (or a cross-origin page,
		// since HEAD is CORS-safe) invoke a mutating admin route by choosing the
		// method (#1853). Astro also dispatches HEAD to the GET export, so no
		// explicit HEAD handler is needed to reach a "GET" route. Gate every
		// private invocation on `plugins:manage` + CSRF regardless of method.
		const denied = requirePerm(user, "plugins:manage");
		if (denied) return denied;

		// Token scope enforcement — plugin routes require "admin" scope.
		// Session auth is implicitly full-access (requireScope returns null).
		const scopeError = requireScope(locals, "admin");
		if (scopeError) return scopeError;

		// CSRF protection on private routes. Plugin routes use soft auth in the
		// middleware (user resolved but not required), so the middleware's CSRF
		// check doesn't run — enforce it here. Applied to every method because
		// any method can trigger a state change (see above). Token-authed
		// requests (which set tokenScopes) are exempt — tokens aren't ambient
		// credentials like cookies.
		if (!locals.tokenScopes && request.headers.get("X-EmDash-Request") !== "1") {
			return apiError("CSRF_REJECTED", "Missing required header", 403);
		}
	}

	const result = await emdash.handlePluginApiRoute(pluginId, method, `/${path}`, request);

	if (!result.success) {
		const code = result.error?.code ?? "PLUGIN_ERROR";
		// Pass through messages from known plugin errors (PluginRouteError),
		// but mask internal errors (unhandled exceptions) to avoid leaking
		// database errors, file paths, etc. from sandboxed plugins.
		const message =
			code === "INTERNAL_ERROR"
				? "Plugin route error"
				: (result.error?.message ?? "Plugin route error");
		// PluginRouteError status is returned at the top level of the result
		const status = (result as { status?: number }).status ?? (code === "NOT_FOUND" ? 404 : 400);
		return apiError(code, message, status);
	}

	return apiSuccess(result.data);
};

// Export handlers for all HTTP methods
export const GET = handleRequest;
export const POST = handleRequest;
export const PUT = handleRequest;
export const PATCH = handleRequest;
export const DELETE = handleRequest;
