/**
 * OAuth Device Flow handlers (RFC 8628).
 *
 * EmDash acts as an OAuth 2.0 authorization server. The CLI requests
 * a device code, displays a URL + user code, and polls for a token.
 * The user opens a browser, logs in, enters the code, and the CLI gets
 * an access + refresh token pair.
 *
 * Uses arctic for code generation and @emdash-cms/auth for token utilities.
 */

import { clampScopes } from "@emdash-cms/auth";
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
import type { ApiResult } from "../types.js";
import { lookupOAuthClient } from "./oauth-clients.js";
import { lookupUserRoleAndStatus } from "./oauth-user-lookup.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Device codes expire after 15 minutes */
const DEVICE_CODE_TTL_SECONDS = 15 * 60;

/** Default polling interval in seconds */
const DEFAULT_INTERVAL = 5;

/** RFC 8628 §3.5: interval increase on slow_down */
const SLOW_DOWN_INCREMENT = 5;

/** Maximum slow_down interval cap (seconds) */
const MAX_SLOW_DOWN_INTERVAL = 60;

/** Access token TTL: 1 hour */
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/** Refresh token TTL: 90 days */
const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Default scopes for CLI login */
const DEFAULT_SCOPES = [
	"content:read",
	"content:write",
	"media:read",
	"media:write",
	"schema:read",
] as const;

/** Pattern to normalize user codes (strip hyphens) */
const HYPHEN_PATTERN = /-/g;

/** Characters for user codes (uppercase, no ambiguous chars like 0/O, 1/I) */
const USER_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

export interface TokenResponse {
	access_token: string;
	refresh_token: string;
	token_type: "Bearer";
	expires_in: number;
	scope: string;
}

// RFC 8628 error codes
export type DeviceFlowError =
	| "authorization_pending"
	| "slow_down"
	| "expired_token"
	| "access_denied";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a short human-readable user code (XXXX-XXXX) */
function generateUserCode(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	const chars = Array.from(bytes, (b) => USER_CODE_CHARS[b % USER_CODE_CHARS.length]).join("");
	return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

/** Get an ISO datetime string offset from now */
function expiresAt(seconds: number): string {
	return new Date(Date.now() + seconds * 1000).toISOString();
}

/** Validate and normalize scopes. Returns validated scope list. */
function normalizeScopes(requested?: string[]): string[] {
	if (!requested || requested.length === 0) {
		return [...DEFAULT_SCOPES];
	}
	const validSet = new Set<string>(VALID_SCOPES);
	return requested.filter((s) => validSet.has(s));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * POST /oauth/device/code
 *
 * Issue a device code + user code. The CLI displays the user code
 * and tells the user to open the verification URI.
 */
export async function handleDeviceCodeRequest(
	db: Kysely<Database>,
	input: {
		client_id?: string;
		scope?: string;
	},
	verificationUri: string,
): Promise<ApiResult<DeviceCodeResponse>> {
	try {
		// Parse and validate scopes
		const requestedScopes = input.scope ? input.scope.split(" ").filter(Boolean) : [];
		const scopes = normalizeScopes(requestedScopes);

		if (scopes.length === 0) {
			return {
				success: false,
				error: { code: "INVALID_SCOPE", message: "No valid scopes requested" },
			};
		}

		const deviceCode = generateCodeVerifier();
		const userCode = generateUserCode();
		const expires = expiresAt(DEVICE_CODE_TTL_SECONDS);

		await db
			.insertInto("_emdash_device_codes")
			.values({
				device_code: deviceCode,
				user_code: userCode,
				scopes: JSON.stringify(scopes),
				status: "pending",
				expires_at: expires,
				interval: DEFAULT_INTERVAL,
			})
			.execute();

		return {
			success: true,
			data: {
				device_code: deviceCode,
				user_code: userCode,
				verification_uri: verificationUri,
				expires_in: DEVICE_CODE_TTL_SECONDS,
				interval: DEFAULT_INTERVAL,
			},
		};
	} catch {
		return {
			success: false,
			error: {
				code: "DEVICE_CODE_ERROR",
				message: "Failed to create device code",
			},
		};
	}
}

/**
 * POST /oauth/device/token
 *
 * CLI polls this endpoint with the device_code. Returns:
 * - 200 with tokens if authorized
 * - 400 with error "authorization_pending" while waiting
 * - 400 with error "slow_down" if polling too fast
 * - 400 with error "expired_token" if the code expired
 * - 400 with error "access_denied" if the user denied
 */
export async function handleDeviceTokenExchange(
	db: Kysely<Database>,
	input: {
		device_code: string;
		grant_type: string;
	},
): Promise<
	ApiResult<TokenResponse> & { deviceFlowError?: DeviceFlowError; deviceFlowInterval?: number }
> {
	try {
		// Validate grant_type
		if (input.grant_type !== "urn:ietf:params:oauth:grant-type:device_code") {
			return {
				success: false,
				error: { code: "UNSUPPORTED_GRANT_TYPE", message: "Invalid grant_type" },
			};
		}

		// Look up the device code
		const row = await db
			.selectFrom("_emdash_device_codes")
			.selectAll()
			.where("device_code", "=", input.device_code)
			.executeTakeFirst();

		if (!row) {
			return {
				success: false,
				error: { code: "INVALID_GRANT", message: "Invalid device code" },
			};
		}

		const now = new Date();

		// Check expiry
		if (new Date(row.expires_at) < now) {
			// Clean up expired code
			await db
				.deleteFrom("_emdash_device_codes")
				.where("device_code", "=", input.device_code)
				.execute();

			return {
				success: false,
				deviceFlowError: "expired_token",
				error: { code: "expired_token", message: "The device code has expired" },
			};
		}

		// Check status
		if (row.status === "denied") {
			// Clean up denied code
			await db
				.deleteFrom("_emdash_device_codes")
				.where("device_code", "=", input.device_code)
				.execute();

			return {
				success: false,
				deviceFlowError: "access_denied",
				error: { code: "access_denied", message: "The user denied the request" },
			};
		}

		if (row.status === "pending") {
			// RFC 8628 §3.5: slow_down enforcement during polling phase.
			// Only applies while waiting for authorization — once authorized,
			// the final exchange proceeds without throttling.
			if (row.last_polled_at) {
				const lastPolled = new Date(row.last_polled_at);
				const elapsedSeconds = (now.getTime() - lastPolled.getTime()) / 1000;

				if (elapsedSeconds < row.interval) {
					// Too fast — increase interval by 5s per RFC 8628 §3.5, capped at 60s
					const newInterval = Math.min(row.interval + SLOW_DOWN_INCREMENT, MAX_SLOW_DOWN_INTERVAL);
					await db
						.updateTable("_emdash_device_codes")
						.set({
							interval: newInterval,
							last_polled_at: now.toISOString(),
						})
						.where("device_code", "=", input.device_code)
						.execute();

					return {
						success: false,
						deviceFlowError: "slow_down",
						deviceFlowInterval: newInterval,
						error: { code: "slow_down", message: "Polling too fast" },
					};
				}
			}

			// Update last_polled_at for future slow_down checks
			await db
				.updateTable("_emdash_device_codes")
				.set({ last_polled_at: now.toISOString() })
				.where("device_code", "=", input.device_code)
				.execute();

			return {
				success: false,
				deviceFlowError: "authorization_pending",
				error: { code: "authorization_pending", message: "Authorization pending" },
			};
		}

		if (row.status !== "authorized" || !row.user_id) {
			return {
				success: false,
				error: { code: "INVALID_GRANT", message: "Invalid device code state" },
			};
		}

		// Generate tokens before consuming the device code so that if
		// generation fails, the code is still available for retry.
		const accessToken = generatePrefixedToken(TOKEN_PREFIXES.OAUTH_ACCESS);
		const accessExpires = expiresAt(ACCESS_TOKEN_TTL_SECONDS);
		const refreshToken = generatePrefixedToken(TOKEN_PREFIXES.OAUTH_REFRESH);
		const refreshExpires = expiresAt(REFRESH_TOKEN_TTL_SECONDS);

		// Atomically consume the device code and create tokens in a single
		// transaction. DELETE...RETURNING prevents TOCTOU: two concurrent
		// requests race on the DELETE, only one gets a row back. Wrapping
		// in a transaction ensures the code isn't consumed if token storage fails.
		const result = await withTransaction(db, async (trx) => {
			const consumed = await trx
				.deleteFrom("_emdash_device_codes")
				.where("device_code", "=", input.device_code)
				.where("status", "=", "authorized")
				.returningAll()
				.executeTakeFirst();

			if (!consumed) return null;

			if (!consumed.user_id) return null;

			const scopes = JSON.parse(consumed.scopes) as string[];

			await trx
				.insertInto("_emdash_oauth_tokens")
				.values({
					token_hash: accessToken.hash,
					token_type: "access",
					user_id: consumed.user_id,
					scopes: JSON.stringify(scopes),
					client_type: "cli",
					expires_at: accessExpires,
					refresh_token_hash: refreshToken.hash,
				})
				.execute();

			await trx
				.insertInto("_emdash_oauth_tokens")
				.values({
					token_hash: refreshToken.hash,
					token_type: "refresh",
					user_id: consumed.user_id,
					scopes: JSON.stringify(scopes),
					client_type: "cli",
					expires_at: refreshExpires,
					refresh_token_hash: null,
				})
				.execute();

			return { scopes };
		});

		if (!result) {
			return {
				success: false,
				error: { code: "INVALID_GRANT", message: "Device code already consumed" },
			};
		}

		return {
			success: true,
			data: {
				access_token: accessToken.raw,
				refresh_token: refreshToken.raw,
				token_type: "Bearer",
				expires_in: ACCESS_TOKEN_TTL_SECONDS,
				scope: result.scopes.join(" "),
			},
		};
	} catch {
		return {
			success: false,
			error: {
				code: "TOKEN_EXCHANGE_ERROR",
				message: "Failed to exchange device code",
			},
		};
	}
}

/**
 * POST /oauth/device/authorize
 *
 * The user submits the user_code after logging in via the browser.
 * This authorizes the device code, allowing the CLI to exchange it for tokens.
 *
 * Scopes are clamped to the user's role at this point. The stored scopes
 * are replaced with the intersection of requested scopes and the scopes
 * the user's role permits. This prevents scope escalation.
 */
export async function handleDeviceAuthorize(
	db: Kysely<Database>,
	userId: string,
	userRole: RoleLevel,
	input: {
		user_code: string;
		action?: "approve" | "deny";
	},
): Promise<ApiResult<{ authorized: boolean }>> {
	try {
		// Normalize user code (strip hyphens, uppercase)
		const normalizedCode = input.user_code.replace(HYPHEN_PATTERN, "").toUpperCase();

		// Look up the device code by user_code
		const row = await db
			.selectFrom("_emdash_device_codes")
			.selectAll()
			.where("status", "=", "pending")
			.execute();

		// Find the matching code (strip hyphens for comparison)
		const match = row.find(
			(r) => r.user_code.replace(HYPHEN_PATTERN, "").toUpperCase() === normalizedCode,
		);

		if (!match) {
			return {
				success: false,
				error: { code: "INVALID_CODE", message: "Invalid or expired code" },
			};
		}

		// Check expiry
		if (new Date(match.expires_at) < new Date()) {
			await db
				.deleteFrom("_emdash_device_codes")
				.where("device_code", "=", match.device_code)
				.execute();

			return {
				success: false,
				error: { code: "EXPIRED_CODE", message: "This code has expired" },
			};
		}

		const action = input.action ?? "approve";

		if (action === "deny") {
			await db
				.updateTable("_emdash_device_codes")
				.set({ status: "denied" })
				.where("device_code", "=", match.device_code)
				.execute();

			return { success: true, data: { authorized: false } };
		}

		// Clamp requested scopes to those the user's role permits.
		// effective_scopes = requested_scopes ∩ scopesForRole(user.role)
		const requestedScopes = JSON.parse(match.scopes) as string[];
		const effectiveScopes = clampScopes(requestedScopes, userRole);

		if (effectiveScopes.length === 0) {
			return {
				success: false,
				error: {
					code: "INSUFFICIENT_ROLE",
					message: "Your role does not permit any of the requested scopes",
				},
			};
		}

		// Approve: set user_id, status, and clamped scopes
		await db
			.updateTable("_emdash_device_codes")
			.set({
				status: "authorized",
				user_id: userId,
				scopes: JSON.stringify(effectiveScopes),
			})
			.where("device_code", "=", match.device_code)
			.execute();

		return { success: true, data: { authorized: true } };
	} catch {
		return {
			success: false,
			error: {
				code: "AUTHORIZE_ERROR",
				message: "Failed to authorize device",
			},
		};
	}
}

/**
 * POST /oauth/token/refresh
 *
 * Exchange a refresh token for a new access token.
 * The refresh token itself is not rotated (per spec: optional rotation).
 */
export async function handleTokenRefresh(
	db: Kysely<Database>,
	input: {
		refresh_token: string;
		grant_type: string;
	},
): Promise<ApiResult<TokenResponse>> {
	try {
		if (input.grant_type !== "refresh_token") {
			return {
				success: false,
				error: { code: "UNSUPPORTED_GRANT_TYPE", message: "Invalid grant_type" },
			};
		}

		if (!input.refresh_token.startsWith(TOKEN_PREFIXES.OAUTH_REFRESH)) {
			return {
				success: false,
				error: { code: "INVALID_GRANT", message: "Invalid refresh token format" },
			};
		}

		const refreshHash = hashApiToken(input.refresh_token);

		const row = await db
			.selectFrom("_emdash_oauth_tokens")
			.selectAll()
			.where("token_hash", "=", refreshHash)
			.where("token_type", "=", "refresh")
			.executeTakeFirst();

		if (!row) {
			return {
				success: false,
				error: { code: "INVALID_GRANT", message: "Invalid refresh token" },
			};
		}

		// Check expiry
		if (new Date(row.expires_at) < new Date()) {
			// Clean up expired refresh token and its access tokens
			await db.deleteFrom("_emdash_oauth_tokens").where("token_hash", "=", refreshHash).execute();
			await db
				.deleteFrom("_emdash_oauth_tokens")
				.where("refresh_token_hash", "=", refreshHash)
				.execute();

			return {
				success: false,
				error: { code: "INVALID_GRANT", message: "Refresh token expired" },
			};
		}

		// SEC-42: Revalidate user role before issuing new access token.
		// SEC-43: Reject refresh if user is disabled or deleted.
		const userInfo = await lookupUserRoleAndStatus(db, row.user_id);
		if (!userInfo) {
			// User no longer exists — revoke all their tokens
			await db.deleteFrom("_emdash_oauth_tokens").where("user_id", "=", row.user_id).execute();
			return {
				success: false,
				error: { code: "INVALID_GRANT", message: "User not found" },
			};
		}

		if (userInfo.disabled) {
			// User is disabled — revoke all their tokens
			await db.deleteFrom("_emdash_oauth_tokens").where("user_id", "=", row.user_id).execute();
			return {
				success: false,
				error: { code: "INVALID_GRANT", message: "User account is disabled" },
			};
		}

		// Revalidate stored scopes against the user's current role.
		// A demoted user's refresh token may carry stale elevated scopes.
		const storedScopes = JSON.parse(row.scopes) as string[];
		let scopes = clampScopes(storedScopes, userInfo.role);

		// SEC-41: Intersect with the client's registered scopes (if any).
		// Same check as the approval path — a client registered with limited
		// scopes should never receive elevated scopes on refresh, even if the
		// user's role would allow them.
		if (row.client_id) {
			const client = await lookupOAuthClient(db, row.client_id);
			if (client?.scopes?.length) {
				scopes = scopes.filter((s: string) => client.scopes!.includes(s));
			}
		}

		if (scopes.length === 0) {
			// User's role no longer supports any of the token's scopes — revoke
			await db.deleteFrom("_emdash_oauth_tokens").where("token_hash", "=", refreshHash).execute();
			await db
				.deleteFrom("_emdash_oauth_tokens")
				.where("refresh_token_hash", "=", refreshHash)
				.execute();
			return {
				success: false,
				error: {
					code: "INVALID_GRANT",
					message: "User role no longer supports any of the token's scopes",
				},
			};
		}

		// Delete old access tokens for this refresh token
		await db
			.deleteFrom("_emdash_oauth_tokens")
			.where("refresh_token_hash", "=", refreshHash)
			.where("token_type", "=", "access")
			.execute();

		// Generate new access token
		const accessToken = generatePrefixedToken(TOKEN_PREFIXES.OAUTH_ACCESS);
		const accessExpires = expiresAt(ACCESS_TOKEN_TTL_SECONDS);

		await db
			.insertInto("_emdash_oauth_tokens")
			.values({
				token_hash: accessToken.hash,
				token_type: "access",
				user_id: row.user_id,
				scopes: JSON.stringify(scopes),
				client_type: row.client_type,
				expires_at: accessExpires,
				refresh_token_hash: refreshHash,
			})
			.execute();

		return {
			success: true,
			data: {
				access_token: accessToken.raw,
				refresh_token: input.refresh_token, // Return same refresh token
				token_type: "Bearer",
				expires_in: ACCESS_TOKEN_TTL_SECONDS,
				scope: scopes.join(" "),
			},
		};
	} catch {
		return {
			success: false,
			error: {
				code: "TOKEN_REFRESH_ERROR",
				message: "Failed to refresh token",
			},
		};
	}
}

/**
 * POST /oauth/token/revoke
 *
 * Revoke an access or refresh token. If a refresh token is revoked,
 * also revoke all associated access tokens.
 *
 * Per RFC 7009, this endpoint always returns 200 (even for invalid tokens).
 */
export async function handleTokenRevoke(
	db: Kysely<Database>,
	input: {
		token: string;
	},
): Promise<ApiResult<{ revoked: boolean }>> {
	try {
		const hash = hashApiToken(input.token);

		// Look up the token
		const row = await db
			.selectFrom("_emdash_oauth_tokens")
			.select(["token_hash", "token_type", "refresh_token_hash"])
			.where("token_hash", "=", hash)
			.executeTakeFirst();

		if (!row) {
			// Per RFC 7009: always 200, even for invalid tokens
			return { success: true, data: { revoked: true } };
		}

		if (row.token_type === "refresh") {
			// Revoke refresh token and all its access tokens
			await db.deleteFrom("_emdash_oauth_tokens").where("refresh_token_hash", "=", hash).execute();
			await db.deleteFrom("_emdash_oauth_tokens").where("token_hash", "=", hash).execute();
		} else {
			// Revoke just the access token
			await db.deleteFrom("_emdash_oauth_tokens").where("token_hash", "=", hash).execute();
		}

		return { success: true, data: { revoked: true } };
	} catch {
		return {
			success: false,
			error: {
				code: "TOKEN_REVOKE_ERROR",
				message: "Failed to revoke token",
			},
		};
	}
}
