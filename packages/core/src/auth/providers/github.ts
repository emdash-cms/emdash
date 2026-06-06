/**
 * GitHub OAuth Auth Provider
 *
 * Returns an AuthProviderDescriptor for GitHub OAuth login.
 * Credentials are read from environment variables at runtime.
 *
 * @example
 * ```ts
 * import { github } from "emdash/auth/providers/github";
 *
 * emdash({
 *   authProviders: [github()],
 * })
 * ```
 */

import type { AuthProviderDescriptor } from "../types.js";

/**
 * Configure GitHub OAuth as an auth provider.
 *
 * Requires `EMDASH_OAUTH_GITHUB_CLIENT_ID` and `EMDASH_OAUTH_GITHUB_CLIENT_SECRET`
 * (or `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`) environment variables.
 */
export function github(): AuthProviderDescriptor {
	return {
		id: "github",
		label: "GitHub",
		adminEntry: "emdash/auth/providers/github-admin",
	};
}
