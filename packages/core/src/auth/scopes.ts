/**
 * Scope enforcement for API token authentication.
 *
 * Routes call `requireScope(locals, "content:write")` alongside role checks.
 * Session-authenticated requests have no scope restrictions (implicit full access).
 * Token-authenticated requests must have the required scope (or "admin").
 */

import { apiError } from "#api/error.js";

import { hasScope } from "./api-tokens.js";

/**
 * Check if the request has a required scope.
 * Returns a 403 Response if the scope is missing, or null if OK.
 *
 * For session-authenticated users (no tokenScopes), always returns null
 * since session auth has implicit full scope.
 */
export function requireScope(locals: { tokenScopes?: string[] }, scope: string): Response | null {
	// Session auth = no scope restrictions
	if (!locals.tokenScopes) return null;

	if (hasScope(locals.tokenScopes, scope)) return null;

	return apiError("INSUFFICIENT_SCOPE", `Token lacks required scope: ${scope}`, 403);
}
