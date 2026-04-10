/**
 * Auth Provider Types
 *
 * Defines the interfaces for pluggable authentication providers.
 *
 * Two systems coexist:
 * - `AuthDescriptor` — transparent auth (Cloudflare Access) that authenticates
 *   every request via headers/cookies. No login UI needed.
 * - `AuthProviderDescriptor` — pluggable login methods (GitHub, Google,
 *   AT Protocol, etc.) that appear as options on the login page and setup
 *   wizard. Passkey is built-in; providers are additive.
 */

/**
 * Result of authenticating a request via an external auth provider
 */
export interface AuthResult {
	/** User's email address */
	email: string;
	/** User's display name */
	name: string;
	/** Resolved role level (e.g., 50 for Admin, 30 for Editor) */
	role: number;
	/** Provider-specific subject ID */
	subject?: string;
	/** Additional provider-specific data */
	metadata?: Record<string, unknown>;
}

/**
 * Auth descriptor — transparent auth providers (e.g., Cloudflare Access).
 *
 * These authenticate every request via headers/cookies. No login UI needed.
 * The module's `authenticate()` function is called by middleware on each request.
 */
export interface AuthDescriptor {
	/**
	 * Auth provider type identifier
	 * @example "cloudflare-access", "okta", "auth0"
	 */
	type: string;

	/**
	 * Module specifier to import at runtime
	 * The module must export an `authenticate` function.
	 * @example "@emdash-cms/cloudflare/auth"
	 */
	entrypoint: string;

	/**
	 * Provider-specific configuration (JSON-serializable)
	 */
	config: unknown;
}

/**
 * Auth provider module interface
 *
 * Modules specified by AuthDescriptor.entrypoint must export
 * an `authenticate` function matching this signature.
 */
export interface AuthProviderModule {
	/**
	 * Authenticate a request using the provider
	 *
	 * @param request - The incoming HTTP request
	 * @param config - Provider-specific configuration from AuthDescriptor
	 * @returns Authentication result if valid, throws if invalid
	 */
	authenticate(request: Request, config: unknown): Promise<AuthResult>;
}

// ---------------------------------------------------------------------------
// Pluggable Auth Providers (additive login methods)
// ---------------------------------------------------------------------------

/**
 * Descriptor for a pluggable auth provider.
 *
 * Auth providers appear as login options on the login page and setup wizard.
 * They coexist with passkey (which is built-in) and with each other.
 * Any provider can be used to create the initial admin account.
 *
 * @example
 * ```ts
 * // astro.config.ts
 * import { atproto } from "@emdash-cms/auth-atproto";
 *
 * emdash({
 *   authProviders: [atproto(), github(), google()],
 * })
 * ```
 */
export interface AuthProviderDescriptor {
	/** Unique provider ID (e.g., "github", "atproto") */
	id: string;

	/** Human-readable label for UI (e.g., "GitHub", "AT Protocol") */
	label: string;

	/** Provider-specific config (JSON-serializable) */
	config?: unknown;

	/**
	 * Module exporting React components for the admin UI.
	 * Statically imported at build time via virtual module.
	 *
	 * The module should export components matching `AuthProviderAdminExports`.
	 */
	adminEntry?: string;

	/**
	 * Astro route handlers this provider needs injected at build time.
	 * Used for login initiation, OAuth callbacks, well-known endpoints, etc.
	 */
	routes?: AuthRouteDescriptor[];

	/**
	 * URL prefixes/paths that should bypass auth middleware.
	 * Added to the public routes set so login/callback endpoints work
	 * for unauthenticated users.
	 */
	publicRoutes?: string[];

	/**
	 * Storage collections for persistent auth state (e.g., OAuth sessions).
	 * Same format as plugin storage — collections are stored in the shared
	 * `_plugin_storage` table namespaced under `auth:<providerId>`.
	 *
	 * Access via `getAuthProviderStorage()` from `emdash/api/route-utils`.
	 */
	storage?: Record<
		string,
		{ indexes?: Array<string | string[]>; uniqueIndexes?: Array<string | string[]> }
	>;
}

/**
 * A route that an auth provider needs injected into the Astro app.
 */
export interface AuthRouteDescriptor {
	/** URL pattern (e.g., "/_emdash/api/auth/atproto/login") */
	pattern: string;
	/** Module specifier for the Astro route handler */
	entrypoint: string;
}

/**
 * Expected exports from an auth provider's `adminEntry` module.
 *
 * All exports are optional. Providers export whichever components
 * make sense for their auth flow.
 */
export interface AuthProviderAdminExports {
	/**
	 * Compact button for the login page (icon + label).
	 * Used for providers with a simple redirect flow (GitHub, Google).
	 * Rendered in the "Or continue with" section.
	 */
	LoginButton?: import("react").ComponentType;

	/**
	 * Full login form for providers that need custom input.
	 * Used for providers like AT Protocol that need a handle field.
	 * Rendered as an expandable section on the login page.
	 */
	LoginForm?: import("react").ComponentType;

	/**
	 * Setup wizard step for creating the admin account via this provider.
	 * When present, this provider appears as an option in the setup wizard's
	 * "Create admin account" step.
	 */
	SetupStep?: import("react").ComponentType<{ onComplete: () => void }>;
}

/**
 * Configuration options common to external auth providers
 */
export interface ExternalAuthConfig {
	/**
	 * Automatically create EmDash users on first login
	 * @default true
	 */
	autoProvision?: boolean;

	/**
	 * Role level for users not matching any group in roleMapping
	 * @default 30 (Editor)
	 */
	defaultRole?: number;

	/**
	 * Update user's role on each login based on current IdP groups
	 * When false, role is only set on first provisioning
	 * @default false
	 */
	syncRoles?: boolean;

	/**
	 * Map IdP group names to EmDash role levels
	 * First match wins if user is in multiple groups
	 *
	 * @example
	 * ```ts
	 * roleMapping: {
	 *   "Admins": 50,        // Admin
	 *   "Developers": 40,    // Developer
	 *   "Content Team": 30,  // Editor
	 * }
	 * ```
	 */
	roleMapping?: Record<string, number>;
}
