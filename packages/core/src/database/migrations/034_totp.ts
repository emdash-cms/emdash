import type { Kysely } from "kysely";

import { currentTimestamp } from "../dialect-helpers.js";

/**
 * totp_secrets (one row per user) + an index on auth_tokens(user_id,
 * type) that the recovery-code lookup uses at login time.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("totp_secrets")
		.addColumn("user_id", "text", (col) => col.primaryKey())
		.addColumn("encrypted_secret", "text", (col) => col.notNull())
		.addColumn("algorithm", "text", (col) => col.notNull().defaultTo("SHA1"))
		.addColumn("digits", "integer", (col) => col.notNull().defaultTo(6))
		.addColumn("period", "integer", (col) => col.notNull().defaultTo(30))
		.addColumn("last_used_step", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("failed_attempts", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("locked_until", "text")
		.addColumn("verified", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.addForeignKeyConstraint("totp_secrets_user_fk", ["user_id"], "users", ["id"], (cb) =>
			cb.onDelete("cascade"),
		)
		.execute();

	await db.schema
		.createIndex("idx_auth_tokens_user_type")
		.on("auth_tokens")
		.columns(["user_id", "type"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("idx_auth_tokens_user_type").execute();
	await db.schema.dropTable("totp_secrets").execute();
}
