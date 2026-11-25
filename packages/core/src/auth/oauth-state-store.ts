/**
 * OAuth state store
 *
 * Stores OAuth state in the auth_challenges table with automatic expiration.
 * Uses the existing table but with type="oauth" to distinguish from WebAuthn challenges.
 */

import type { StateStore, OAuthState } from "@emdash-cms/auth";
import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Holds the `state` of a sign-in this browser started. A stored state only
 * shows that some browser started a sign-in, so the callback also requires
 * this cookie to match. Each sign-in gets its own cookie, named after the
 * start of its state, so sign-ins started in several tabs can all finish.
 */
const OAUTH_STATE_COOKIE_PREFIX = "emdash_oauth_state_";
const STATE_NAME_LENGTH = 16;
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export const OAUTH_STATE_COOKIE_PATH = "/_emdash/api/auth/oauth/";

/** Cookie name for `state`, or null when `state` is not a state EmDash issues. */
export function oauthStateCookieName(state: string): string | null {
	if (!STATE_PATTERN.test(state)) return null;
	return OAUTH_STATE_COOKIE_PREFIX + state.slice(0, STATE_NAME_LENGTH);
}

export function createOAuthStateStore(db: Kysely<Database>): StateStore {
	return {
		async set(state: string, data: OAuthState): Promise<void> {
			const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString();

			await db
				.insertInto("auth_challenges")
				.values({
					challenge: state,
					type: "oauth",
					user_id: null,
					data: JSON.stringify(data),
					expires_at: expiresAt,
				})
				.onConflict((oc) =>
					oc.column("challenge").doUpdateSet({
						type: "oauth",
						data: JSON.stringify(data),
						expires_at: expiresAt,
					}),
				)
				.execute();
		},

		async get(state: string): Promise<OAuthState | null> {
			const row = await db
				.selectFrom("auth_challenges")
				.selectAll()
				.where("challenge", "=", state)
				.where("type", "=", "oauth")
				.executeTakeFirst();

			if (!row) return null;

			const expiresAt = new Date(row.expires_at).getTime();

			// Check expiration
			if (expiresAt < Date.now()) {
				// Expired, delete and return null
				await this.delete(state);
				return null;
			}

			if (!row.data) return null;

			try {
				const parsed: unknown = JSON.parse(row.data);
				if (
					typeof parsed !== "object" ||
					parsed === null ||
					!("provider" in parsed) ||
					typeof parsed.provider !== "string" ||
					!("redirectUri" in parsed) ||
					typeof parsed.redirectUri !== "string"
				) {
					return null;
				}
				const oauthState: OAuthState = {
					provider: parsed.provider,
					redirectUri: parsed.redirectUri,
				};
				if ("codeVerifier" in parsed && typeof parsed.codeVerifier === "string") {
					oauthState.codeVerifier = parsed.codeVerifier;
				}
				if ("nonce" in parsed && typeof parsed.nonce === "string") {
					oauthState.nonce = parsed.nonce;
				}
				if ("inviteToken" in parsed && typeof parsed.inviteToken === "string") {
					oauthState.inviteToken = parsed.inviteToken;
				}
				return oauthState;
			} catch {
				return null;
			}
		},

		async delete(state: string): Promise<void> {
			await db
				.deleteFrom("auth_challenges")
				.where("challenge", "=", state)
				.where("type", "=", "oauth")
				.execute();
		},
	};
}
