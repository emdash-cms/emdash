/**
 * OAuth types
 */

export interface OAuthProfile {
	id: string;
	email: string;
	name: string | null;
	avatarUrl: string | null;
	emailVerified: boolean;
}

export interface OAuthProvider {
	name: string;
	authorizeUrl: string;
	tokenUrl: string;
	userInfoUrl?: string;
	scopes: string[];

	/**
	 * Verify the ID token from the token response and return its claims.
	 * When present, the authorization request carries a nonce, and
	 * `parseProfile` receives these claims instead of a userinfo response.
	 */
	verifyIdToken?(idToken: string, nonce: string): Promise<unknown>;

	/**
	 * Refuse self-signup when `parseProfile` reports an unverified email.
	 */
	requireVerifiedEmailForSignup?: boolean;

	/**
	 * Parse the user profile from the provider's response
	 */
	parseProfile(data: unknown): OAuthProfile;
}

export interface OAuthConfig {
	clientId: string;
	clientSecret: string;
}

export interface MicrosoftOAuthConfig extends OAuthConfig {
	/** Directory (tenant) ID, or `common`, `organizations` or `consumers` */
	tenant: string;
	/**
	 * Whether sign-in email addresses count as verified. When unset, only
	 * accounts that sign in through a configured directory (tenant) ID count
	 * as verified, and only for an address in the domain of their sign-in name
	 * or confirmed by the `xms_edov` claim.
	 */
	emailVerified?: boolean;
}

export interface OAuthState {
	provider: string;
	redirectUri: string;
	codeVerifier?: string; // For PKCE
	nonce?: string;
	/**
	 * When present, this OAuth flow is accepting an invite. The callback
	 * completes the invite (creating the user with the invited role and linking
	 * the OAuth account) instead of falling back to the self-signup policy, but
	 * only when the provider-verified email matches the invited address.
	 */
	inviteToken?: string;
}
