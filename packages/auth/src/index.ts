/**
 * @emdash-cms/auth - Passkey-first authentication for EmDash
 *
 * Email is now handled by the plugin email pipeline (see PLUGIN-EMAIL.md).
 * Auth functions accept an optional `email` send function instead of a
 * hardcoded adapter. The route layer bridges `emdash.email.send()` from
 * the pipeline into the auth functions.
 *
 * @example
 * ```ts
 * import { auth } from '@emdash-cms/auth'
 *
 * export default defineConfig({
 *   integrations: [
 *     emdash({
 *       auth: auth({
 *         secret: import.meta.env.EMDASH_AUTH_SECRET,
 *         passkeys: { rpName: 'My Site' },
 *       }),
 *     }),
 *   ],
 * })
 * ```
 */

// Types
export * from "./types.js";

// Config
import { authConfigSchema as _authConfigSchema } from "./config.js";
export {
	authConfigSchema,
	resolveConfig,
	type AuthConfig,
	type ResolvedAuthConfig,
} from "./config.js";

// RBAC
export {
	Permissions,
	hasPermission,
	requirePermission,
	canActOnOwn,
	requirePermissionOnResource,
	PermissionError,
	scopesForRole,
	clampScopes,
	type Permission,
} from "./rbac.js";

// Tokens
export {
	generateToken,
	hashToken,
	generateTokenWithHash,
	generateSessionId,
	generateAuthSecret,
	secureCompare,
	encrypt,
	decrypt,
	// HKDF-based encryption (for high-entropy secrets like TOTP keys)
	encryptWithHKDF,
	decryptWithHKDF,
	// Prefixed API tokens (ec_pat_, ec_oat_, ec_ort_)
	TOKEN_PREFIXES,
	generatePrefixedToken,
	hashPrefixedToken,
	// Scopes
	VALID_SCOPES,
	validateScopes,
	hasScope,
	type ApiTokenScope,
	// PKCE
	computeS256Challenge,
} from "./tokens.js";

// Passkey
export * from "./passkey/index.js";

// Magic Link
export {
	sendMagicLink,
	verifyMagicLink,
	MagicLinkError,
	type MagicLinkConfig,
} from "./magic-link/index.js";

// Invite
export {
	createInvite,
	createInviteToken,
	validateInvite,
	completeInvite,
	InviteError,
	escapeHtml,
	type InviteConfig,
	type InviteTokenResult,
	type EmailSendFn,
} from "./invite.js";

// Signup
export {
	canSignup,
	requestSignup,
	validateSignupToken,
	completeSignup,
	SignupError,
	type SignupConfig,
} from "./signup.js";

// OAuth
export {
	createAuthorizationUrl,
	handleOAuthCallback,
	OAuthError,
	github,
	google,
	type StateStore,
	type OAuthConsumerConfig,
} from "./oauth/consumer.js";
export type { OAuthProvider, OAuthConfig, OAuthProfile, OAuthState } from "./oauth/types.js";

// Email types (implementations moved to plugin email pipeline)
export type { EmailAdapter, EmailMessage } from "./types.js";

/**
 * Create an auth configuration
 *
 * This is a helper function that validates the config at runtime.
 */
export function auth(config: import("./config.js").AuthConfig): import("./config.js").AuthConfig {
	// Validate config
	const result = _authConfigSchema.safeParse(config);
	if (!result.success) {
		throw new Error(`Invalid auth config: ${result.error.message}`);
	}
	return result.data;
}
