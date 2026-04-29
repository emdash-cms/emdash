/**
 * OAuth 2.1 Authorization Code + PKCE handlers.
 *
 * Implements the server side of the authorization code grant for MCP clients
 * (Claude Desktop, VS Code, etc.) per the MCP authorization spec (draft).
 *
 * Uses arctic for PKCE challenge generation and @emdash-cms/auth for token
 * utilities. Token infrastructure is shared with the device flow.
 */

import { clampScopes, computeS256Challenge, secureCompare } from "@emdash-cms/auth";
import type { RoleLevel } from "@emdash-cms/auth";
import { generateCodeVerifier } from "arctic";
import type { Kysely } from "kysely";

import {
	generatePrefixedToken,
	hashApiToken,
	TOKEN_PREFIXES,
	VALID_SCOPES,
} from "../../auth/api-tokens.js";
import { withTransaction } from "../../database/transaction.js";
import type { Database } from "../../database/types.js";
import { validateRedirectUri } from "../oauth/redirect-uri.js";
import type { ApiResult } from "../types.js";
import { lookupOAuthClient, validateClientRedirectUri } from "./oauth-clients.js";
import { lookupUserRoleAndStatus } from "./oauth-user-lookup.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Authorization codes expire after 10 minutes (RFC 6749 §4.1.2 recommends short-lived) */
const AUTH_CODE_TTL_SECONDS = 10 * 60;

/** Access token TTL: 1 hour */
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/** Refresh token TTL: 90 days */
const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthorizationParams {
	response_type: string;
	client_id: string;
	redirect_uri: string;
	scope?: string;
	state?: string;
	code_challenge: string;
	code_challenge_method: string;
	resource?: string;
}

export interface TokenExchangeParams {
	grant_type: string;
	code: string;
	redirect_uri: string;
	client_id: string;
	code_verifier: string;
	resource?: string;
}

export interface TokenResponse {
	access_token: string;
	refresh_token: string;
	token_type: "Bearer";
	expires_in: number;
	scope: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expiresAt(seconds: number): string {
	return new Date(Date.now() + seconds * 1000).toISOString();
}

export { validateRedirectUri };

/**
 * Validate and normalize scopes. Returns validated scope list.
 */
function normalizeScopes(requested?: string): string[] {
	if (!requested) return [];

	const validSet = new Set<string>(VALID_SCOPES);
	const scopes = requested
		.split(" ")
		.filter(Boolean)
		.filter((s) => validSet.has(s));

	return scopes;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Process an authorization request after the user approves consent.
 *
 * Generates an authorization code, stores it with the PKCE challenge,
 * and returns the redirect URL with the code appended.
 *
 * Scopes are clamped to the user's role to prevent scope escalation.
 */
export async function handleAuthorizationApproval(
	db: Kysely<Database>,
	userId: string,
	userRole: RoleLevel,
	params: AuthorizationParams,
): Promise<ApiResult<{ redirect_url: string }>> {
	try {
		// Validate response_type
		if (params.response_type !== "code") {
			return {
				success: false,
				error: {
					code: "UNSUPPORTED_RESPONSE_TYPE",
					message: "Only response_type=code is supported",
				},
			};
		}

		// Validate redirect_uri scheme/host (basic security check)
		const uriError = validateRedirectUri(params.redirect_uri);
		if (uriError) {
			return {
				success: false,
				error: { code: "INVALID_REDIRECT_URI", message: uriError },
			};
		}

		// Look up the registered OAuth client
		const client = await lookupOAuthClient(db, params.client_id);
		if (!client) {
			return {
				success: false,
				error: {
					code: "INVALID_CLIENT",
					message: "Unknown client_id",
				},
			};
		}

		// Validate redirect_uri against client's registered URIs
		const clientUriError = validateClientRedirectUri(params.redirect_uri, client.redirectUris);
		if (clientUriError) {
			return {
				success: false,
				error: { code: "INVALID_REDIRECT_URI", message: clientUriError },
			};
		}

		// Validate code_challenge_method
		if (params.code_challenge_method !== "S256") {
			return {
				success: false,
				error: {
					code: "INVALID_REQUEST",
					message: "Only S256 code_challenge_method is supported",
				},
			};
		}

		// Validate code_challenge is present
		if (!params.code_challenge) {
			return {
				success: false,
				error: { code: "INVALID_REQUEST", message: "code_challenge is required" },
			};
		}

		// Validate scopes, then clamp to user's role
		const userScopes = clampScopes(normalizeScopes(params.scope), userRole);

		// SEC-41: Intersect with client's registered scopes (if restricted).
		// A client registered with scopes: ["content:read"] should never receive
		// admin or schema:write, regardless of the approving user's role.
		const clientScopes = client.scopes;
		const scopes = clientScopes?.length
			? userScopes.filter((s: string) => clientScopes.includes(s))
			: userScopes;

		if (scopes.length === 0) {
			return {
				success: false,
				error: { code: "INVALID_SCOPE", message: "No valid scopes requested" },
			};
		}

		// Generate authorization code (high entropy, base64url)
		const code = generateCodeVerifier(); // 32 bytes random, base64url
		const codeHash = hashApiToken(code);

		// Store the authorization code
		await db
			.insertInto("_emdash_authorization_codes")
			.values({
				code_hash: codeHash,
				client_id: params.client_id,
				redirect_uri: params.redirect_uri,
				user_id: userId,
				scopes: JSON.stringify(scopes),
				code_challenge: params.code_challenge,
				code_challenge_method: params.code_challenge_method,
				resource: params.resource ?? null,
				expires_at: expiresAt(AUTH_CODE_TTL_SECONDS),
			})
			.execute();

		// Build the redirect URL
		const redirectUrl = new URL(params.redirect_uri);
		redirectUrl.searchParams.set("code", code);
		if (params.state) {
			redirectUrl.searchParams.set("state", params.state);
		}

		return {
			success: true,
			data: { redirect_url: redirectUrl.toString() },
		};
	} catch (error) {
		console.error("Authorization error:", error);
		return {
			success: false,
			error: {
				code: "AUTHORIZATION_ERROR",
				message: "Failed to process authorization",
			},
		};
	}
}

/**
 * Exchange an authorization code for access + refresh tokens.
 *
 * Validates the code, verifies PKCE, and issues tokens using the same
 * infrastructure as the device flow (ec_oat_*, ec_ort_*).
 */
export async function handleAuthorizationCodeExchange(
	db: Kysely<Database>,
	params: TokenExchangeParams,
): Promise<ApiResult<TokenResponse>> {
	try {
		// Validate grant_type
		if (params.grant_type !== "authorization_code") {
			return {
				success: false,
				error: { code: "unsupported_grant_type", message: "Invalid grant_type" },
			};
		}

		// SEC-39: Atomically consume the authorization code using DELETE...RETURNING.
		// This prevents TOCTOU double-exchange: two concurrent requests with the
		// same code will race on the DELETE, and only one will get a row back.
		const codeHash = hashApiToken(params.code);

		const row = await db
			.deleteFrom("_emdash_authorization_codes")
			.where("code_hash", "=", codeHash)
			.returningAll()
			.executeTakeFirst();

		if (!row) {
			return {
				success: false,
				error: { code: "invalid_grant", message: "Invalid authorization code" },
			};
		}

		// Check expiry
		if (new Date(row.expires_at) < new Date()) {
			return {
				success: false,
				error: { code: "invalid_grant", message: "Authorization code expired" },
			};
		}

		// Verify redirect_uri matches exactly
		if (row.redirect_uri !== params.redirect_uri) {
			return {
				success: false,
				error: { code: "invalid_grant", message: "redirect_uri mismatch" },
			};
		}

		// Verify client_id matches
		if (row.client_id !== params.client_id) {
			return {
				success: false,
				error: { code: "invalid_grant", message: "client_id mismatch" },
			};
		}

		// PKCE verification: SHA256(code_verifier) must match stored code_challenge
		// Use constant-time comparison to prevent timing side-channels
		const derivedChallenge = computeS256Challenge(params.code_verifier);
		if (!secureCompare(derivedChallenge, row.code_challenge)) {
			return {
				success: false,
				error: { code: "invalid_grant", message: "PKCE verification failed" },
			};
		}

		// Verify resource matches (if stored)
		if (row.resource && params.resource && row.resource !== params.resource) {
			return {
				success: false,
				error: { code: "invalid_grant", message: "resource mismatch" },
			};
		}

		// Revalidate user role before issuing tokens (same pattern as handleTokenRefresh).
		// The user's role may have changed since the authorization code was issued.
		const userInfo = await lookupUserRoleAndStatus(db, row.user_id);
		if (!userInfo) {
			return {
				success: false,
				error: { code: "invalid_grant", message: "User not found" },
			};
		}

		if (userInfo.disabled) {
			return {
				success: false,
				error: { code: "invalid_grant", message: "User account is disabled" },
			};
		}

		// Re-clamp scopes against the user's current role
		const storedScopes = JSON.parse(row.scopes) as string[];
		let scopes = clampScopes(storedScopes, userInfo.role);

		// Intersect with client's registered scopes (if restricted)
		const client = await lookupOAuthClient(db, row.client_id);
		if (client?.scopes?.length) {
			scopes = scopes.filter((s: string) => client.scopes!.includes(s));
		}

		if (scopes.length === 0) {
			return {
				success: false,
				error: {
					code: "invalid_grant",
					message: "User role no longer supports any of the requested scopes",
				},
			};
		}

		// Issue tokens (same as device flow)
		const accessToken = generatePrefixedToken(TOKEN_PREFIXES.OAUTH_ACCESS);
		const accessExpires = expiresAt(ACCESS_TOKEN_TTL_SECONDS);

		const refreshToken = generatePrefixedToken(TOKEN_PREFIXES.OAUTH_REFRESH);
		const refreshExpires = expiresAt(REFRESH_TOKEN_TTL_SECONDS);

		// Atomically store both tokens in a transaction
		await withTransaction(db, async (trx) => {
			await trx
				.insertInto("_emdash_oauth_tokens")
				.values({
					token_hash: accessToken.hash,
					token_type: "access",
					user_id: row.user_id,
					scopes: JSON.stringify(scopes),
					client_type: "mcp",
					expires_at: accessExpires,
					refresh_token_hash: refreshToken.hash,
					client_id: row.client_id,
				})
				.execute();

			await trx
				.insertInto("_emdash_oauth_tokens")
				.values({
					token_hash: refreshToken.hash,
					token_type: "refresh",
					user_id: row.user_id,
					scopes: JSON.stringify(scopes),
					client_type: "mcp",
					expires_at: refreshExpires,
					refresh_token_hash: null,
					client_id: row.client_id,
				})
				.execute();
		});

		return {
			success: true,
			data: {
				access_token: accessToken.raw,
				refresh_token: refreshToken.raw,
				token_type: "Bearer",
				expires_in: ACCESS_TOKEN_TTL_SECONDS,
				scope: scopes.join(" "),
			},
		};
	} catch (error) {
		console.error("Token exchange error:", error);
		return {
			success: false,
			error: {
				code: "TOKEN_EXCHANGE_ERROR",
				message: "Failed to exchange authorization code",
			},
		};
	}
}

/**
 * Build the authorization denied redirect URL.
 */
export function buildDeniedRedirect(redirectUri: string, state?: string): string {
	const url = new URL(redirectUri);
	url.searchParams.set("error", "access_denied");
	url.searchParams.set("error_description", "The user denied the authorization request");
	if (state) {
		url.searchParams.set("state", state);
	}
	return url.toString();
}

/**
 * Clean up expired authorization codes.
 */
export async function cleanupExpiredAuthorizationCodes(db: Kysely<Database>): Promise<number> {
	const result = await db
		.deleteFrom("_emdash_authorization_codes")
		.where("expires_at", "<", new Date().toISOString())
		.executeTakeFirst();

	return Number(result.numDeletedRows);
}
