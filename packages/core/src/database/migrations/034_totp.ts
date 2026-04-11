import type { Kysely } from "kysely";

import { currentTimestamp } from "../dialect-helpers.js";

/**
 * Migration: TOTP authenticator-app credentials.
 *
 * Adds the `totp_secrets` table — one row per user — that backs the
 * authenticator-app login method as an alternative to passkeys.
 *
 * Columns and why:
 * - encrypted_secret: HKDF-encrypted TOTP key bytes (NOT PBKDF2 — see
 *   tokens.ts encryptWithHKDF for the why).
 * - last_used_step: RFC 6238 §5.2 replay protection. The verifier rejects
 *   any code whose candidate epoch counter is `<=` this value.
 * - failed_attempts: consecutive verification failures. Reset to 0 on
 *   success or recovery code use. Triggers lockout at 10.
 * - locked_until: ISO timestamp string (TEXT for SQLite compat). NULL
 *   when not locked. Set when failed_attempts hits the threshold.
 * - verified: 0 during setup, 1 after the user proves they scanned the
 *   QR by submitting a valid code. Currently always 1 by the time the row
 *   is persisted (the unverified secret lives in auth_challenges instead),
 *   but the column is here so a future split can add a true two-step flow.
 * - algorithm/digits/period: locked at SHA1/6/30 today, but persisted so
 *   we can support per-user customization (e.g. 8-digit codes for a
 *   compliance use case) without a follow-up migration.
 *
 * Also adds an index on auth_tokens(user_id, type) so the recovery-code
 * lookup at login time doesn't full-table-scan auth_tokens. Recovery codes
 * are stored as auth_tokens rows with type='recovery'.
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

	// Index on (user_id, type) for recovery code lookup at login time.
	// Recovery codes are stored as auth_tokens rows with type='recovery';
	// the verifier queries `WHERE user_id = ? AND type = 'recovery'` and
	// without this index that's a full scan of auth_tokens.
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
