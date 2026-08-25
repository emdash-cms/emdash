/**
 * OAuth state store
 *
 * Stores OAuth state in the auth_challenges table with automatic expiration.
 * Uses the existing table but with type="oauth" to distinguish from WebAuthn challenges.
 */

import type { StateStore, OAuthState } from "@emdash-cms/auth";
import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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
