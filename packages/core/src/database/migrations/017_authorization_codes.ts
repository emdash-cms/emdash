import type { ColumnDataType, Kysely } from "kysely";
import { sql } from "kysely";

import { currentTimestamp, detectDialect } from "../dialect-helpers.js";

async function getForeignKeyColumnType(
	db: Kysely<unknown>,
	referencedTable: string,
	referencedColumn: string,
): Promise<ColumnDataType> {
	try {
		const result = await sql<{ data_type: string }>`
            SELECT data_type
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = ${referencedTable} AND column_name = ${referencedColumn}
        `.execute(db);
		const colType = result.rows[0]?.data_type ?? null;
		if (colType === "uuid") return "uuid";
		return "text";
	} catch {
		return "text";
	}
}

/**
 * Authorization codes for OAuth 2.1 Authorization Code + PKCE flow.
 *
 * Used by MCP clients (Claude Desktop, VS Code, etc.) to authenticate
 * via the standard OAuth authorization code grant.
 *
 * Also adds client_id tracking to oauth_tokens for per-client revocation.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	const dialect = detectDialect(db);
	const userIdType =
		dialect === "postgres" ? await getForeignKeyColumnType(db, "users", "id") : "text";

	await db.schema
		.createTable("_emdash_authorization_codes")
		.addColumn("code_hash", "text", (col) => col.primaryKey()) // SHA-256 hash of authorization code
		.addColumn("client_id", "text", (col) => col.notNull()) // CIMD URL or opaque string
		.addColumn("redirect_uri", "text", (col) => col.notNull()) // Must match exactly on exchange
		.addColumn("user_id", userIdType, (col) => col.notNull())
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
		.on("_emdash_authorization_codes")
		.column("expires_at")
		.execute();

	// Track which client obtained a token (for per-client revocation)
	await sql`ALTER TABLE _emdash_oauth_tokens ADD COLUMN client_id TEXT`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_authorization_codes").execute();
	// SQLite doesn't support DROP COLUMN, but this is only for dev rollback
}
