/**
 * ATProto OAuth store adapters
 *
 * Implements the NodeSavedStateStore and NodeSavedSessionStore interfaces
 * required by @atproto/oauth-client-node, backed by the existing
 * auth_challenges table.
 *
 * State entries (type="atproto") are short-lived PKCE state during the
 * OAuth flow (~10 min TTL). Session entries (type="atproto_session") hold
 * DPoP keys and tokens; they are deleted after login completes.
 */

import type { NodeSavedSession, NodeSavedState } from "@atproto/oauth-client-node";
import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";

type SimpleStore<K extends string, V> = {
	get(key: K): Promise<V | undefined>;
	set(key: K, value: V): Promise<void>;
	del(key: K): Promise<void>;
};

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour (safety net for abandoned flows)

export function createAtprotoStateStore(db: Kysely<Database>): SimpleStore<string, NodeSavedState> {
	return {
		async get(key: string): Promise<NodeSavedState | undefined> {
			const row = await db
				.selectFrom("auth_challenges")
				.selectAll()
				.where("challenge", "=", key)
				.where("type", "=", "atproto")
				.executeTakeFirst();

			if (!row?.data) return undefined;

			if (new Date(row.expires_at).getTime() < Date.now()) {
				await this.del(key);
				return undefined;
			}

			try {
				return JSON.parse(row.data) as NodeSavedState;
			} catch {
				return undefined;
			}
		},

		async set(key: string, value: NodeSavedState): Promise<void> {
			const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();

			await db
				.insertInto("auth_challenges")
				.values({
					challenge: key,
					type: "atproto",
					user_id: null,
					data: JSON.stringify(value),
					expires_at: expiresAt,
				})
				.onConflict((oc) =>
					oc.column("challenge").doUpdateSet({
						type: "atproto",
						data: JSON.stringify(value),
						expires_at: expiresAt,
					}),
				)
				.execute();
		},

		async del(key: string): Promise<void> {
			await db
				.deleteFrom("auth_challenges")
				.where("challenge", "=", key)
				.where("type", "=", "atproto")
				.execute();
		},
	};
}

export function createAtprotoSessionStore(
	db: Kysely<Database>,
): SimpleStore<string, NodeSavedSession> {
	return {
		async get(key: string): Promise<NodeSavedSession | undefined> {
			const row = await db
				.selectFrom("auth_challenges")
				.selectAll()
				.where("challenge", "=", key)
				.where("type", "=", "atproto_session")
				.executeTakeFirst();

			if (!row?.data) return undefined;

			if (new Date(row.expires_at).getTime() < Date.now()) {
				await this.del(key);
				return undefined;
			}

			try {
				return JSON.parse(row.data) as NodeSavedSession;
			} catch {
				return undefined;
			}
		},

		async set(key: string, value: NodeSavedSession): Promise<void> {
			const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

			await db
				.insertInto("auth_challenges")
				.values({
					challenge: key,
					type: "atproto_session",
					user_id: null,
					data: JSON.stringify(value),
					expires_at: expiresAt,
				})
				.onConflict((oc) =>
					oc.column("challenge").doUpdateSet({
						type: "atproto_session",
						data: JSON.stringify(value),
						expires_at: expiresAt,
					}),
				)
				.execute();
		},

		async del(key: string): Promise<void> {
			await db
				.deleteFrom("auth_challenges")
				.where("challenge", "=", key)
				.where("type", "=", "atproto_session")
				.execute();
		},
	};
}
