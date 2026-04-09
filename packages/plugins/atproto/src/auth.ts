/**
 * AT Protocol PDS Authentication Provider
 *
 * Config-time function that returns an AuthProviderDescriptor for use in astro.config.ts.
 * When configured, EmDash adds AT Protocol as a login option alongside passkey and
 * any other configured auth providers.
 *
 * @example
 * ```ts
 * import { atproto } from "@emdash-cms/plugin-atproto/auth";
 *
 * export default defineConfig({
 *   integrations: [
 *     emdash({
 *       authProviders: [
 *         atproto({ allowedDIDs: ["did:plc:abc123"] }),
 *       ],
 *     }),
 *   ],
 * });
 * ```
 */

import type { AuthProviderDescriptor } from "emdash";

/**
 * Configuration for AT Protocol PDS authentication
 */
export interface AtprotoAuthConfig {
	/**
	 * Restrict login to specific DIDs (optional allowlist).
	 * DIDs are permanent cryptographic identifiers that can't be spoofed.
	 *
	 * @example ["did:plc:abc123", "did:web:example.com"]
	 */
	allowedDIDs?: string[];

	/**
	 * Restrict login to handles matching these patterns (optional allowlist).
	 * Supports exact matches and wildcard domains (e.g., `"*.example.com"`).
	 *
	 * Handle ownership is independently verified via DNS TXT / HTTP resolution
	 * (not trusting the PDS's claim), so this is safe for org-level gating
	 * where the org controls the domain.
	 *
	 * If both `allowedDIDs` and `allowedHandles` are set, a user matching
	 * either list is allowed.
	 *
	 * @example ["*.mycompany.com", "alice.bsky.social"]
	 */
	allowedHandles?: string[];

	/**
	 * Default role level for users who are not the first user.
	 * First user always gets Admin (50).
	 * Valid values: 10 (Subscriber), 20 (Contributor), 30 (Author), 40 (Editor), 50 (Admin).
	 * @default 10 (Subscriber)
	 */
	defaultRole?: number;
}

/**
 * Configure AT Protocol PDS authentication as a pluggable auth provider.
 *
 * Users authenticate by signing in through their PDS's authorization page.
 * No passkeys or app passwords required — the user authenticates however
 * their PDS supports (password, passkey, etc.).
 *
 * @param config Optional configuration
 * @returns AuthProviderDescriptor for use in `emdash({ authProviders: [...] })`
 */
export function atproto(config?: AtprotoAuthConfig): AuthProviderDescriptor {
	return {
		id: "atproto",
		label: "AT Protocol",
		config: config ?? {},
		adminEntry: "@emdash-cms/plugin-atproto/admin",
		routes: [
			{
				pattern: "/_emdash/api/auth/atproto/login",
				entrypoint: "@emdash-cms/plugin-atproto/routes/login.ts",
			},
			{
				pattern: "/_emdash/api/auth/atproto/callback",
				entrypoint: "@emdash-cms/plugin-atproto/routes/callback.ts",
			},
			{
				pattern: "/_emdash/api/setup/atproto-admin",
				entrypoint: "@emdash-cms/plugin-atproto/routes/setup-admin.ts",
			},
			{
				// Served at root /.well-known/ (not /_emdash/) so PDS authorization
				// servers can fetch them quickly without hitting the EmDash middleware chain.
				pattern: "/.well-known/atproto-client-metadata.json",
				entrypoint: "@emdash-cms/plugin-atproto/routes/client-metadata.ts",
			},
		],
		publicRoutes: ["/_emdash/api/auth/atproto/"],
	};
}
