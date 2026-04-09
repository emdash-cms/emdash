/**
 * Database-backed store for AT Protocol OAuth state and sessions.
 *
 * Replaces MemoryStore to support multi-instance deployments (e.g., Cloudflare
 * Workers) where in-memory state is lost between requests.
 *
 * Uses a single `_emdash_atproto_store` table with (namespace, key) as the
 * composite primary key. The table is auto-created on first access.
 */

import type { Store } from "@atcute/oauth-node-client";
import { sql, type Kysely } from "kysely";

interface AtprotoStoreTable {
	namespace: string;
	key: string;
	value: string;
	expires_at: number | null;
}

interface AtprotoStoreDb {
	_emdash_atproto_store: AtprotoStoreTable;
}

let _tableCreated = false;

async function ensureTable(db: Kysely<unknown>): Promise<void> {
	if (_tableCreated) return;
	await sql`CREATE TABLE IF NOT EXISTS _emdash_atproto_store (
		namespace TEXT NOT NULL,
		key TEXT NOT NULL,
		value TEXT NOT NULL,
		expires_at INTEGER,
		PRIMARY KEY (namespace, key)
	)`.execute(db);
	_tableCreated = true;
}

/**
 * Create a database-backed Store<K, V> for the atcute OAuth client.
 *
 * @param getDb - Function that returns the current Kysely instance.
 *                Using a getter instead of a direct reference because on
 *                Cloudflare Workers the db binding changes per request.
 * @param namespace - Store namespace (e.g., "states" or "sessions")
 */
export function createDbStore<K extends string, V>(
	getDb: () => Kysely<unknown>,
	namespace: string,
): Store<K, V> {
	return {
		async get(key: K): Promise<V | undefined> {
			const db = getDb();
			await ensureTable(db);
			const result = await sql<{ value: string; expires_at: number | null }>`
				SELECT value, expires_at FROM _emdash_atproto_store
				WHERE namespace = ${namespace} AND key = ${key}
			`.execute(db);
			const row = (result as { rows: { value: string; expires_at: number | null }[] }).rows[0];
			if (!row) return undefined;
			// Check expiry
			if (row.expires_at && Date.now() > row.expires_at * 1000) {
				await sql`DELETE FROM _emdash_atproto_store
					WHERE namespace = ${namespace} AND key = ${key}`.execute(db);
				return undefined;
			}
			return JSON.parse(row.value) as V;
		},

		async set(key: K, value: V): Promise<void> {
			const db = getDb();
			await ensureTable(db);
			const json = JSON.stringify(value);
			// Extract expiresAt from StoredState if present
			const expiresAt = (value as { expiresAt?: number }).expiresAt ?? null;
			await (db as unknown as Kysely<AtprotoStoreDb>)
				.insertInto("_emdash_atproto_store")
				.values({ namespace, key, value: json, expires_at: expiresAt })
				.onConflict((oc) =>
					oc.columns(["namespace", "key"]).doUpdateSet({ value: json, expires_at: expiresAt }),
				)
				.execute();
		},

		async delete(key: K): Promise<void> {
			const db = getDb();
			await ensureTable(db);
			await sql`DELETE FROM _emdash_atproto_store
				WHERE namespace = ${namespace} AND key = ${key}`.execute(db);
		},

		async clear(): Promise<void> {
			const db = getDb();
			await ensureTable(db);
			await sql`DELETE FROM _emdash_atproto_store
				WHERE namespace = ${namespace}`.execute(db);
		},
	};
}
