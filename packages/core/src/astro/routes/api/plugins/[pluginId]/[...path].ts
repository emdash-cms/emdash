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

import { apiError } from "#api/error.js";
import { dispatchPluginApiRequest } from "#plugins/http-route-dispatch.js";

export const prerender = false;

/**
 * Handle all methods by matching against plugin-defined routes
 */
const handleRequest: APIRoute = async ({ params, request, locals, cache }) => {
	const { emdash, user } = locals;
	const pluginId = params.pluginId!;
	const path = params.path || "";
	if (!emdash?.handlePluginApiRoute) {
		return apiError("NOT_CONFIGURED", "EmDash not configured", 500);
	}
	return dispatchPluginApiRequest({
		runtime: emdash,
		pluginId,
		path: `/${path}`,
		request,
		user,
		tokenScopes: locals.tokenScopes,
		invalidateContentCache: cache?.enabled ? (tags) => cache.invalidate({ tags }) : undefined,
	});
};

// Export handlers for all HTTP methods
export const GET = handleRequest;
export const HEAD = handleRequest;
export const POST = handleRequest;
export const PUT = handleRequest;
export const PATCH = handleRequest;
export const DELETE = handleRequest;
