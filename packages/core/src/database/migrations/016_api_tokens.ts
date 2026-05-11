import type { Kysely } from "kysely";

import { currentTimestamp } from "../dialect-helpers.js";

/**
 * API token tables for programmatic access.
 *
 * Three tables:
 * 1. _emdash_api_tokens — Personal Access Tokens (ec_pat_...)
 * 2. _emdash_oauth_tokens — OAuth access/refresh tokens (ec_oat_/ec_ort_...)
 * 3. _emdash_device_codes — OAuth Device Flow state (RFC 8628)
 *
 * Every CREATE is guarded with `.ifNotExists()` so the migration is safe to
 * re-run against a partially-applied schema. See #954 for the failure mode:
 * if `up()` crashes mid-way (D1 subrequest limit, isolate cancellation,
 * transient connection error), the migration record never gets inserted
 * into `_emdash_migrations`, and the next request retries `up()` from the
 * top. Without these guards, the retry crashed with `table ... already
 * exists` and blocked every subsequent boot of the Worker.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	// ── Personal Access Tokens ───────────────────────────────────────
	await db.schema
		.createTable("_emdash_api_tokens")
		.ifNotExists()
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("name", "text", (col) => col.notNull())
		.addColumn("token_hash", "text", (col) => col.notNull().unique())
		.addColumn("prefix", "text", (col) => col.notNull())
		.addColumn("user_id", "text", (col) => col.notNull())
		.addColumn("scopes", "text", (col) => col.notNull()) // JSON array
		.addColumn("expires_at", "text") // null = no expiry
		.addColumn("last_used_at", "text")
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addForeignKeyConstraint("api_tokens_user_fk", ["user_id"], "users", ["id"], (cb) =>
			cb.onDelete("cascade"),
		)
		.execute();

	await db.schema
		.createIndex("idx_api_tokens_token_hash")
		.ifNotExists()
		.on("_emdash_api_tokens")
		.column("token_hash")
		.execute();

	await db.schema
		.createIndex("idx_api_tokens_user_id")
		.ifNotExists()
		.on("_emdash_api_tokens")
		.column("user_id")
		.execute();

	// ── OAuth Tokens ─────────────────────────────────────────────────
	await db.schema
		.createTable("_emdash_oauth_tokens")
		.ifNotExists()
		.addColumn("token_hash", "text", (col) => col.primaryKey())
		.addColumn("token_type", "text", (col) => col.notNull()) // 'access' | 'refresh'
		.addColumn("user_id", "text", (col) => col.notNull())
		.addColumn("scopes", "text", (col) => col.notNull()) // JSON array
		.addColumn("client_type", "text", (col) => col.notNull().defaultTo("cli"))
		.addColumn("expires_at", "text", (col) => col.notNull())
		.addColumn("refresh_token_hash", "text") // links access → refresh
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addForeignKeyConstraint("oauth_tokens_user_fk", ["user_id"], "users", ["id"], (cb) =>
			cb.onDelete("cascade"),
		)
		.execute();

	await db.schema
		.createIndex("idx_oauth_tokens_user_id")
		.ifNotExists()
		.on("_emdash_oauth_tokens")
		.column("user_id")
		.execute();

	await db.schema
		.createIndex("idx_oauth_tokens_expires")
		.ifNotExists()
		.on("_emdash_oauth_tokens")
		.column("expires_at")
		.execute();

	// ── Device Codes (OAuth Device Flow, RFC 8628) ───────────────────
	await db.schema
		.createTable("_emdash_device_codes")
		.ifNotExists()
		.addColumn("device_code", "text", (col) => col.primaryKey())
		.addColumn("user_code", "text", (col) => col.notNull().unique())
		.addColumn("scopes", "text", (col) => col.notNull()) // JSON array
		.addColumn("user_id", "text") // set when user authorizes
		.addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
		.addColumn("expires_at", "text", (col) => col.notNull())
		.addColumn("interval", "integer", (col) => col.notNull().defaultTo(5))
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_device_codes").ifExists().execute();
	await db.schema.dropTable("_emdash_oauth_tokens").ifExists().execute();
	await db.schema.dropTable("_emdash_api_tokens").ifExists().execute();
}
