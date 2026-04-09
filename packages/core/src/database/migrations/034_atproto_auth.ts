import { sql, type Kysely } from "kysely";

/**
 * Migration: ATProto OAuth login support.
 *
 * Adds atproto_did column to users table so ATProto identities (DIDs)
 * can be associated with user accounts. This enables login via Bluesky
 * handle or any AT Protocol PDS.
 *
 * ATProto OAuth state and session data reuse the existing auth_challenges
 * table with type="atproto" and type="atproto_session".
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("users").addColumn("atproto_did", "text").execute();

	// Unique index — each DID maps to exactly one user
	await db.schema
		.createIndex("idx_users_atproto_did")
		.on("users")
		.column("atproto_did")
		.unique()
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("idx_users_atproto_did").execute();
	await db.schema.alterTable("users").dropColumn("atproto_did").execute();
}
