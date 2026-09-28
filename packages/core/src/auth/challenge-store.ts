/**
 * Challenge store for WebAuthn
 *
 * Stores WebAuthn challenges in a dedicated table with automatic expiration.
 */

import type { ChallengeStore, ChallengeData } from "@emdash-cms/auth/passkey";
import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";

export function createChallengeStore(db: Kysely<Database>): ChallengeStore {
	return {
		async set(challenge: string, data: ChallengeData): Promise<void> {
			const expiresAt = new Date(data.expiresAt).toISOString();

			await db
				.insertInto("auth_challenges")
				.values({
					challenge,
					type: data.type,
					user_id: data.userId ?? null,
					data: data.context ?? null,
					expires_at: expiresAt,
				})
				.onConflict((oc) =>
					oc.column("challenge").doUpdateSet({
						type: data.type,
						user_id: data.userId ?? null,
						data: data.context ?? null,
						expires_at: expiresAt,
					}),
				)
				.execute();
		},

		async get(challenge: string): Promise<ChallengeData | null> {
			const row = await db
				.selectFrom("auth_challenges")
				.selectAll()
				.where("challenge", "=", challenge)
				.executeTakeFirst();

			if (!row) return null;

			const expiresAt = new Date(row.expires_at).getTime();

			// Check expiration
			if (expiresAt < Date.now()) {
				// Expired, delete and return null
				await this.delete(challenge);
				return null;
			}

			return {
				type: row.type === "registration" ? "registration" : "authentication",
				userId: row.user_id ?? undefined,
				expiresAt,
				...(row.data === null ? {} : { context: row.data }),
			};
		},

		async delete(challenge: string): Promise<void> {
			await db.deleteFrom("auth_challenges").where("challenge", "=", challenge).execute();
		},
	};
}

/**
 * Clean up expired challenges.
 * Should be called periodically (e.g., on startup, or via cron).
 */
export async function cleanupExpiredChallenges(db: Kysely<Database>): Promise<number> {
	const now = new Date().toISOString();

	const result = await db
		.deleteFrom("auth_challenges")
		.where("expires_at", "<", now)
		.executeTakeFirst();

	return Number(result.numDeletedRows ?? 0);
}
