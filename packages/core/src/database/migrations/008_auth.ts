import type { Kysely } from "kysely";
import { sql } from "kysely";

import { binaryType, currentTimestamp, currentTimestampValue } from "../dialect-helpers.js";

/**
 * Auth migration - passkey-first authentication
 *
 * Changes:
 * - Removes password_hash from users (no passwords)
 * - Adds role as integer (RBAC levels)
 * - Adds email_verified, avatar_url, updated_at to users
 * - Creates credentials table (passkeys)
 * - Creates auth_tokens table (magic links, invites)
 * - Creates oauth_accounts table (external provider links)
 * - Creates allowed_domains table (self-signup)
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	// SQLite doesn't support DROP COLUMN directly, so we need to recreate the table
	// Create new users table with updated schema
	await db.schema
		.createTable("users_new")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("email", "text", (col) => col.notNull().unique())
		.addColumn("name", "text")
		.addColumn("avatar_url", "text")
		.addColumn("role", "integer", (col) => col.notNull().defaultTo(10)) // SUBSCRIBER
		.addColumn("email_verified", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("data", "text")
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.execute();

	// Migrate existing data (map old role strings to new integer levels)
	await sql`
		INSERT INTO users_new (id, email, name, role, data, created_at, updated_at)
		SELECT
			id,
			email,
			name,
			CASE role
				WHEN 'admin' THEN 50
				WHEN 'editor' THEN 40
				WHEN 'author' THEN 30
				WHEN 'contributor' THEN 20
				ELSE 10
			END,
			data,
			created_at,
			${currentTimestampValue(db)}
		FROM users
	`.execute(db);

	// Drop old table and rename new one
	await db.schema.dropTable("users").execute();
	await sql`ALTER TABLE users_new RENAME TO users`.execute(db);

	// Recreate index
	await db.schema.createIndex("idx_users_email").on("users").column("email").execute();

	// Passkey credentials
	await db.schema
		.createTable("credentials")
		.addColumn("id", "text", (col) => col.primaryKey()) // Base64url credential ID
		.addColumn("user_id", "text", (col) => col.notNull())
		.addColumn("public_key", binaryType(db), (col) => col.notNull()) // COSE public key
		.addColumn("counter", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("device_type", "text", (col) => col.notNull()) // 'singleDevice' | 'multiDevice'
		.addColumn("backed_up", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("transports", "text") // JSON array
		.addColumn("name", "text") // User-friendly name
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addColumn("last_used_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addForeignKeyConstraint("credentials_user_fk", ["user_id"], "users", ["id"], (cb) =>
			cb.onDelete("cascade"),
		)
		.execute();

	await db.schema.createIndex("idx_credentials_user").on("credentials").column("user_id").execute();

	// Auth tokens (magic links, email verification, invites, recovery)
	await db.schema
		.createTable("auth_tokens")
		.addColumn("hash", "text", (col) => col.primaryKey()) // SHA-256 hash of token
		.addColumn("user_id", "text")
		.addColumn("email", "text") // For pre-user tokens
		.addColumn("type", "text", (col) => col.notNull()) // 'magic_link' | 'email_verify' | 'invite' | 'recovery'
		.addColumn("role", "integer") // For invites
		.addColumn("invited_by", "text")
		.addColumn("expires_at", "text", (col) => col.notNull())
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addForeignKeyConstraint("auth_tokens_user_fk", ["user_id"], "users", ["id"], (cb) =>
			cb.onDelete("cascade"),
		)
		.addForeignKeyConstraint("auth_tokens_invited_by_fk", ["invited_by"], "users", ["id"], (cb) =>
			cb.onDelete("set null"),
		)
		.execute();

	await db.schema.createIndex("idx_auth_tokens_email").on("auth_tokens").column("email").execute();

	// OAuth accounts (external provider links)
	await db.schema
		.createTable("oauth_accounts")
		.addColumn("provider", "text", (col) => col.notNull())
		.addColumn("provider_account_id", "text", (col) => col.notNull())
		.addColumn("user_id", "text", (col) => col.notNull())
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addPrimaryKeyConstraint("oauth_accounts_pk", ["provider", "provider_account_id"])
		.addForeignKeyConstraint("oauth_accounts_user_fk", ["user_id"], "users", ["id"], (cb) =>
			cb.onDelete("cascade"),
		)
		.execute();

	await db.schema
		.createIndex("idx_oauth_accounts_user")
		.on("oauth_accounts")
		.column("user_id")
		.execute();

	// Allowed domains for self-signup
	await db.schema
		.createTable("allowed_domains")
		.addColumn("domain", "text", (col) => col.primaryKey())
		.addColumn("default_role", "integer", (col) => col.notNull().defaultTo(20)) // CONTRIBUTOR
		.addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.execute();

	// WebAuthn challenges (ephemeral, with TTL)
	await db.schema
		.createTable("auth_challenges")
		.addColumn("challenge", "text", (col) => col.primaryKey()) // Base64url challenge
		.addColumn("type", "text", (col) => col.notNull()) // 'registration' | 'authentication'
		.addColumn("user_id", "text") // For registration, the user being registered
		.addColumn("data", "text") // JSON for additional context
		.addColumn("expires_at", "text", (col) => col.notNull())
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.execute();

	// Index for efficient cleanup of expired challenges
	await db.schema
		.createIndex("idx_auth_challenges_expires")
		.on("auth_challenges")
		.column("expires_at")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// Drop new tables
	await db.schema.dropTable("auth_challenges").execute();
	await db.schema.dropTable("allowed_domains").execute();
	await db.schema.dropTable("oauth_accounts").execute();
	await db.schema.dropTable("auth_tokens").execute();
	await db.schema.dropTable("credentials").execute();

	// Recreate old users table with password_hash
	await db.schema
		.createTable("users_old")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("email", "text", (col) => col.notNull().unique())
		.addColumn("password_hash", "text", (col) => col.notNull())
		.addColumn("name", "text")
		.addColumn("role", "text", (col) => col.defaultTo("subscriber"))
		.addColumn("avatar_id", "text")
		.addColumn("data", "text")
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.execute();

	// Migrate data back (users will have empty password_hash)
	await sql`
		INSERT INTO users_old (id, email, password_hash, name, role, data, created_at)
		SELECT
			id,
			email,
			'', -- No way to restore password
			name,
			CASE role
				WHEN 50 THEN 'admin'
				WHEN 40 THEN 'editor'
				WHEN 30 THEN 'author'
				WHEN 20 THEN 'contributor'
				ELSE 'subscriber'
			END,
			data,
			created_at
		FROM users
	`.execute(db);

	await db.schema.dropTable("users").execute();
	await sql`ALTER TABLE users_old RENAME TO users`.execute(db);

	await db.schema.createIndex("idx_users_email").on("users").column("email").execute();
}
