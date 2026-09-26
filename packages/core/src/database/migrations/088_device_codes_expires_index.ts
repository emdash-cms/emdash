import type { Kysely } from "kysely";

/**
 * Index `_emdash_device_codes.expires_at`.
 *
 * Scheduled cleanup deletes device codes by `expires_at`, as it does OAuth
 * tokens and authorization codes, whose tables already have
 * `idx_oauth_tokens_expires` (016) and `idx_auth_codes_expires` (017). Without
 * this index each cleanup scans the whole device code table.
 *
 * Forward-only and idempotent (`IF NOT EXISTS`), so a run that stopped after
 * creating the index can be retried.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createIndex("idx_device_codes_expires")
		.ifNotExists()
		.on("_emdash_device_codes")
		.column("expires_at")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("idx_device_codes_expires").ifExists().execute();
}
