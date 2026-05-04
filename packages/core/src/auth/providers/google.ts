/**
 * Google OAuth Auth Provider
 *
 * Returns an AuthProviderDescriptor for Google OAuth login.
 * Credentials are read from environment variables at runtime.
 *
 * @example
 * ```ts
 * import { google } from "emdash/auth/providers/google";
 *
 * emdash({
 *   authProviders: [google()],
 * })
 * ```
 */

import type { AuthProviderDescriptor } from "../types.js";

/**
 * Configure Google OAuth as an auth provider.
 *
 * Requires `EMDASH_OAUTH_GOOGLE_CLIENT_ID` and `EMDASH_OAUTH_GOOGLE_CLIENT_SECRET`
 * (or `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) environment variables.
 */
export function google(): AuthProviderDescriptor {
	return {
		id: "google",
		label: "Google",
		adminEntry: "emdash/auth/providers/google-admin",
	};
}
