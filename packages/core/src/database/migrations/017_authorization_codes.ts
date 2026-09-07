import type { Kysely } from "kysely";

import { columnExists, currentTimestamp } from "../dialect-helpers.js";

/**
 * Authorization codes for OAuth 2.1 Authorization Code + PKCE flow.
 *
 * Used by MCP clients (Claude Desktop, VS Code, etc.) to authenticate
 * via the standard OAuth authorization code grant.
 *
 * Also adds client_id tracking to oauth_tokens for per-client revocation.
 *
 * Every statement is guarded so the migration can restart after any one of
 * them has committed. D1 commits each DDL statement on its own and the
 * migrator records the migration only once `up` returns, so an interrupted
 * run leaves the table created and the migration pending; an unguarded
 * `CREATE TABLE` then fails on every retry and the database never finishes
 * migrating.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_authorization_codes")
		.ifNotExists()
		.addColumn("code_hash", "text", (col) => col.primaryKey()) // SHA-256 hash of authorization code
		.addColumn("client_id", "text", (col) => col.notNull()) // CIMD URL or opaque string
		.addColumn("redirect_uri", "text", (col) => col.notNull()) // Must match exactly on exchange
		.addColumn("user_id", "text", (col) => col.notNull())
		.addColumn("scopes", "text", (col) => col.notNull()) // JSON array
		.addColumn("code_challenge", "text", (col) => col.notNull()) // S256 challenge
		.addColumn("code_challenge_method", "text", (col) => col.notNull().defaultTo("S256"))
		.addColumn("resource", "text") // RFC 8707 resource indicator
		.addColumn("expires_at", "text", (col) => col.notNull())
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addForeignKeyConstraint("auth_codes_user_fk", ["user_id"], "users", ["id"], (cb) =>
			cb.onDelete("cascade"),
		)
		.execute();

	await db.schema
		.createIndex("idx_auth_codes_expires")
		.ifNotExists()
		.on("_emdash_authorization_codes")
		.column("expires_at")
		.execute();

	// Track which client obtained a token (for per-client revocation)
	if (!(await columnExists(db, "_emdash_oauth_tokens", "client_id"))) {
		await db.schema.alterTable("_emdash_oauth_tokens").addColumn("client_id", "text").execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_authorization_codes").ifExists().execute();
	// SQLite doesn't support DROP COLUMN, but this is only for dev rollback
}
