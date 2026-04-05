/**
 * OAuth consumer - "Login with X" functionality
 */

import { sha256 } from "@oslojs/crypto/sha2";
import { encodeBase64urlNoPadding } from "@oslojs/encoding";
import { z } from "zod";

import type { AuthAdapter, User, RoleLevel } from "../types.js";
import { github, fetchGitHubEmail } from "./providers/github.js";
import { google } from "./providers/google.js";
import type { OAuthProvider, OAuthConfig, OAuthProfile, OAuthState } from "./types.js";

export { github, google };

export interface OAuthConsumerConfig {
	baseUrl: string;
	providers: {
		github?: OAuthConfig;
		google?: OAuthConfig;
	};
	/**
	 * Check if self-signup is allowed for this email domain
	 */
	canSelfSignup?: (email: string) => Promise<{ allowed: boolean; role: RoleLevel } | null>;
}

/**
 * Generate an OAuth authorization URL
 */
export async function createAuthorizationUrl(
	config: OAuthConsumerConfig,
	providerName: "github" | "google",
	stateStore: StateStore,
): Promise<{ url: string; state: string }> {
	const providerConfig = config.providers[providerName];
	if (!providerConfig) {
		throw new Error(`OAuth provider ${providerName} not configured`);
	}

	const provider = getProvider(providerName);
	const state = generateState();
	const redirectUri = new URL(
		`/_emdash/api/auth/oauth/${providerName}/callback`,
		config.baseUrl,
	).toString();

	// Generate PKCE code verifier for providers that support it
	const codeVerifier = generateCodeVerifier();
	const codeChallenge = await generateCodeChallenge(codeVerifier);

	// Store state for verification
	await stateStore.set(state, {
		provider: providerName,
		redirectUri,
		codeVerifier,
	});

	// Build authorization URL
	const url = new URL(provider.authorizeUrl);
	url.searchParams.set("client_id", providerConfig.clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", provider.scopes.join(" "));
	url.searchParams.set("state", state);

	// PKCE for all providers (GitHub has supported S256 since 2021)
	url.searchParams.set("code_challenge", codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");

	return { url: url.toString(), state };
}

/**
 * Handle OAuth callback
 */
export async function handleOAuthCallback(
	config: OAuthConsumerConfig,
	adapter: AuthAdapter,
	providerName: "github" | "google",
	code: string,
	state: string,
	stateStore: StateStore,
): Promise<User> {
	const providerConfig = config.providers[providerName];
	if (!providerConfig) {
		throw new Error(`OAuth provider ${providerName} not configured`);
	}

	// Verify state
	const storedState = await stateStore.get(state);
	if (!storedState || storedState.provider !== providerName) {
		throw new OAuthError("invalid_state", "Invalid OAuth state");
	}

	// Delete state (single-use)
	await stateStore.delete(state);

	const provider = getProvider(providerName);

	// Exchange code for tokens
	const tokens = await exchangeCode(
		provider,
		providerConfig,
		code,
		storedState.redirectUri,
		storedState.codeVerifier,
	);

	// Fetch user profile
	const profile = await fetchProfile(provider, tokens.accessToken, providerName);

	// Find or create user
	return findOrCreateUser(config, adapter, providerName, profile);
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCode(
	provider: OAuthProvider,
	config: OAuthConfig,
	code: string,
	redirectUri: string,
	codeVerifier?: string,
): Promise<{ accessToken: string; idToken?: string }> {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		client_id: config.clientId,
		client_secret: config.clientSecret,
	});

	if (codeVerifier) {
		body.set("code_verifier", codeVerifier);
	}

	const response = await fetch(provider.tokenUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body,
	});

	if (!response.ok) {
		const error = await response.text();
		throw new OAuthError("token_exchange_failed", `Token exchange failed: ${error}`);
	}

	const json: unknown = await response.json();
	const data = z
		.object({
			access_token: z.string(),
			id_token: z.string().optional(),
		})
		.parse(json);

	return {
		accessToken: data.access_token,
		idToken: data.id_token,
	};
}

/**
 * Fetch user profile from OAuth provider
 */
async function fetchProfile(
	provider: OAuthProvider,
	accessToken: string,
	providerName: string,
): Promise<OAuthProfile> {
	if (!provider.userInfoUrl) {
		throw new Error("Provider does not have userinfo URL");
	}

	const response = await fetch(provider.userInfoUrl, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		throw new OAuthError("profile_fetch_failed", `Failed to fetch profile: ${response.status}`);
	}

	const data = await response.json();
	const profile = provider.parseProfile(data);

	// GitHub may not return email in main profile
	if (providerName === "github" && !profile.email) {
		profile.email = await fetchGitHubEmail(accessToken);
	}

	return profile;
}

/**
 * Find existing user or create new one (with auto-linking)
 */
async function findOrCreateUser(
	config: OAuthConsumerConfig,
	adapter: AuthAdapter,
	providerName: string,
	profile: OAuthProfile,
): Promise<User> {
	// Check if OAuth account already linked
	const existingAccount = await adapter.getOAuthAccount(providerName, profile.id);
	if (existingAccount) {
		const user = await adapter.getUserById(existingAccount.userId);
		if (!user) {
			throw new OAuthError("user_not_found", "Linked user not found");
		}
		return user;
	}

	// Check if user with this email exists (auto-link)
	// Only auto-link when the provider has verified the email to prevent
	// account takeover via unverified email on a third-party provider
	const existingUser = await adapter.getUserByEmail(profile.email);
	if (existingUser) {
		if (!profile.emailVerified) {
			throw new OAuthError(
				"signup_not_allowed",
				"Cannot link account: email not verified by provider",
			);
		}
		await adapter.createOAuthAccount({
			provider: providerName,
			providerAccountId: profile.id,
			userId: existingUser.id,
		});
		return existingUser;
	}

	// Check if self-signup is allowed
	if (config.canSelfSignup) {
		const signup = await config.canSelfSignup(profile.email);
		if (signup?.allowed) {
			// Create new user
			const user = await adapter.createUser({
				email: profile.email,
				name: profile.name,
				avatarUrl: profile.avatarUrl,
				role: signup.role,
				emailVerified: profile.emailVerified,
			});

			// Link OAuth account
			await adapter.createOAuthAccount({
				provider: providerName,
				providerAccountId: profile.id,
				userId: user.id,
			});

			return user;
		}
	}

	throw new OAuthError("signup_not_allowed", "Self-signup not allowed for this email domain");
}

function getProvider(name: "github" | "google"): OAuthProvider {
	switch (name) {
		case "github":
			return github;
		case "google":
			return google;
	}
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a random state string for OAuth CSRF protection
 */
function generateState(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return encodeBase64urlNoPadding(bytes);
}

function generateCodeVerifier(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return encodeBase64urlNoPadding(bytes);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
	const bytes = new TextEncoder().encode(verifier);
	const hash = sha256(bytes);
	return encodeBase64urlNoPadding(hash);
}

// ============================================================================
// State storage interface
// ============================================================================

export interface StateStore {
	set(state: string, data: OAuthState): Promise<void>;
	get(state: string): Promise<OAuthState | null>;
	delete(state: string): Promise<void>;
}

// ============================================================================
// Errors
// ============================================================================

export class OAuthError extends Error {
	constructor(
		public code:
			| "invalid_state"
			| "token_exchange_failed"
			| "profile_fetch_failed"
			| "user_not_found"
			| "signup_not_allowed",
		message: string,
	) {
		super(message);
		this.name = "OAuthError";
	}
}
