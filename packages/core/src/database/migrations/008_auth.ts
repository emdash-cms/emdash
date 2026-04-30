import type { ColumnDataType, Kysely } from "kysely";
import { sql } from "kysely";

import { binaryType, currentTimestamp, currentTimestampValue } from "../dialect-helpers.js";
import { detectDialect } from "../dialect-helpers.js";

async function tableExists(db: Kysely<unknown>, tableName: string): Promise<boolean> {
	const dialect = detectDialect(db);
	if (dialect === "postgres") {
		try {
			const result = await sql<{ exists: boolean }>`
				SELECT EXISTS (
					SELECT FROM information_schema.tables
					WHERE table_schema = 'public' AND table_name = ${tableName}
				) as exists
			`.execute(db);
			return result.rows[0]?.exists ?? false;
		} catch {
			return false;
		}
	}
	// SQLite: query sqlite_master
	try {
		const result = await sql<{ count: number }>`
			SELECT COUNT(*) as count FROM sqlite_master
			WHERE type = 'table' AND name = ${tableName}
		`.execute(db);
		return (result.rows[0]?.count ?? 0) > 0;
	} catch {
		return false;
	}
}

async function getColumnType(
	db: Kysely<unknown>,
	tableName: string,
	columnName: string,
): Promise<string | null> {
	try {
		const result = await sql<{ data_type: string }>`
			SELECT data_type
			FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = ${tableName} AND column_name = ${columnName}
		`.execute(db);
		return result.rows[0]?.data_type ?? null;
	} catch {
		return null;
	}
}

async function getForeignKeyColumnType(
	db: Kysely<unknown>,
	referencedTable: string,
	referencedColumn: string,
): Promise<ColumnDataType> {
	const colType = await getColumnType(db, referencedTable, referencedColumn);
	if (colType === "uuid") return "uuid";
	if (colType === "integer" || colType === "bigint" || colType === "smallint") return "integer";
	return "text";
}

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
 *
 * PostgreSQL-safe: uses ALTER TABLE instead of drop-and-recreate
 * to preserve foreign key constraints from other tables referencing users.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	const dialect = detectDialect(db);

	// Resolve the FK column type to match users.id (text in SQLite, uuid in PG)
	const userIdType =
		dialect === "postgres" ? await getForeignKeyColumnType(db, "users", "id") : "text";

	if (dialect === "postgres") {
		// Guard: if credentials already exists, migration has been applied.
		if (await tableExists(db, "credentials")) return;

		// PostgreSQL path: use ALTER TABLE, safe for foreign key deps
		await sql`ALTER TABLE users
			DROP COLUMN IF EXISTS password_hash,
			DROP COLUMN IF EXISTS avatar_id`.execute(db);

		await sql`ALTER TABLE users
			ADD COLUMN IF NOT EXISTS avatar_url TEXT,
			ADD COLUMN IF NOT EXISTS role INTEGER NOT NULL DEFAULT 10,
			ADD COLUMN IF NOT EXISTS email_verified INTEGER NOT NULL DEFAULT 0,
			ADD COLUMN IF NOT EXISTS updated_at TEXT`.execute(db);

		// Convert existing role strings to integers
		await sql`UPDATE users SET role = 50 WHERE role = 'admin'`.execute(db);
		await sql`UPDATE users SET role = 40 WHERE role = 'editor'`.execute(db);
		await sql`UPDATE users SET role = 30 WHERE role = 'author'`.execute(db);
		await sql`UPDATE users SET role = 20 WHERE role = 'contributor'`.execute(db);
		await sql`
			UPDATE users SET role = 10
			WHERE role = 'subscriber' OR role IS NULL OR CAST(role AS TEXT) = 'subscriber'
		`.execute(db);

		await sql`
			UPDATE users SET updated_at = ${currentTimestampValue(db)} WHERE updated_at IS NULL
		`.execute(db);
	} else {
		// Guard: if credentials already exists, migration has been applied.
		if (await tableExists(db, "credentials")) return;

		// SQLite path: drop-and-recreate users table with updated schema.
		// SQLite can't change column types, so we must recreate the table.
		await db.schema
			.createTable("users_new")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("email", "text", (col) => col.notNull().unique())
			.addColumn("name", "text")
			.addColumn("avatar_url", "text")
			.addColumn("role", "integer", (col) => col.notNull().defaultTo(10))
			.addColumn("email_verified", "integer", (col) => col.notNull().defaultTo(0))
			.addColumn("data", "text")
			.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
			.addColumn("updated_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
			.execute();

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

		await db.schema.dropTable("users").execute();
		await sql`ALTER TABLE users_new RENAME TO users`.execute(db);
		await db.schema.createIndex("idx_users_email").on("users").column("email").execute();
	}

	// Credentials, tokens, accounts, domains: create tables (same for SQLite and Postgres)
	if (!(await tableExists(db, "credentials"))) {
		await db.schema
			.createTable("credentials")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("user_id", userIdType, (col) => col.notNull())
			.addColumn("public_key", binaryType(db), (col) => col.notNull())
			.addColumn("counter", "integer", (col) => col.notNull().defaultTo(0))
			.addColumn("device_type", "text", (col) => col.notNull())
			.addColumn("backed_up", "integer", (col) => col.notNull().defaultTo(0))
			.addColumn("transports", "text")
			.addColumn("name", "text")
			.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
			.addColumn("last_used_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
			.addForeignKeyConstraint("credentials_user_fk", ["user_id"], "users", ["id"], (cb) =>
				cb.onDelete("cascade"),
			)
			.execute();

		await db.schema
			.createIndex("idx_credentials_user")
			.on("credentials")
			.column("user_id")
			.execute();
	}

	if (!(await tableExists(db, "auth_tokens"))) {
		await db.schema
			.createTable("auth_tokens")
			.addColumn("hash", "text", (col) => col.primaryKey())
			.addColumn("user_id", userIdType)
			.addColumn("email", "text")
			.addColumn("type", "text", (col) => col.notNull())
			.addColumn("role", "integer")
			.addColumn("invited_by", userIdType)
			.addColumn("expires_at", "text", (col) => col.notNull())
			.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
			.addForeignKeyConstraint("auth_tokens_user_fk", ["user_id"], "users", ["id"], (cb) =>
				cb.onDelete("cascade"),
			)
			.addForeignKeyConstraint("auth_tokens_invited_by_fk", ["invited_by"], "users", ["id"], (cb) =>
				cb.onDelete("set null"),
			)
			.execute();

		await db.schema
			.createIndex("idx_auth_tokens_email")
			.on("auth_tokens")
			.column("email")
			.execute();
	}

	if (!(await tableExists(db, "oauth_accounts"))) {
		await db.schema
			.createTable("oauth_accounts")
			.addColumn("provider", "text", (col) => col.notNull())
			.addColumn("provider_account_id", "text", (col) => col.notNull())
			.addColumn("user_id", userIdType, (col) => col.notNull())
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
	}

	if (!(await tableExists(db, "allowed_domains"))) {
		await db.schema
			.createTable("allowed_domains")
			.addColumn("domain", "text", (col) => col.primaryKey())
			.addColumn("default_role", "integer", (col) => col.notNull().defaultTo(20))
			.addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
			.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
			.execute();
	}

	if (!(await tableExists(db, "auth_challenges"))) {
		await db.schema
			.createTable("auth_challenges")
			.addColumn("challenge", "text", (col) => col.primaryKey())
			.addColumn("type", "text", (col) => col.notNull())
			.addColumn("user_id", "text")
			.addColumn("data", "text")
			.addColumn("expires_at", "text", (col) => col.notNull())
			.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
			.execute();

		await db.schema
			.createIndex("idx_auth_challenges_expires")
			.on("auth_challenges")
			.column("expires_at")
			.execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// Drop new tables
	await db.schema.dropTable("auth_challenges").ifExists().execute();
	await db.schema.dropTable("allowed_domains").ifExists().execute();
	await db.schema.dropTable("oauth_accounts").ifExists().execute();
	await db.schema.dropTable("auth_tokens").ifExists().execute();
	await db.schema.dropTable("credentials").ifExists().execute();
}
