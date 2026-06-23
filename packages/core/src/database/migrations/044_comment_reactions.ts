import type { Kysely } from "kysely";

import { currentTimestamp } from "../dialect-helpers.js";

/**
 * Comment reactions (Tier 1 of the best-in-class comments RFC).
 *
 * One row per (comment, voter, reaction). Toggle semantics are enforced by the
 * unique index — a voter either has a given reaction on a comment or doesn't.
 * `voter_hash` is a salted SHA-256 of the visitor's IP (same primitive as
 * `_emdash_comments.ip_hash`), so no cleartext identity is stored.
 *
 * Additive and backward-compatible: a new table, no change to existing schema.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_comment_reactions")
		.ifNotExists()
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("comment_id", "text", (col) =>
			col.notNull().references("_emdash_comments.id").onDelete("cascade"),
		)
		.addColumn("reaction", "text", (col) => col.notNull().defaultTo("like"))
		.addColumn("voter_hash", "text", (col) => col.notNull())
		.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(db)))
		.execute();

	// One reaction of a given type per voter per comment (toggle semantics).
	await db.schema
		.createIndex("idx_comment_reactions_unique")
		.ifNotExists()
		.on("_emdash_comment_reactions")
		.columns(["comment_id", "voter_hash", "reaction"])
		.unique()
		.execute();

	// Aggregate counts per comment (GROUP BY comment_id, reaction).
	await db.schema
		.createIndex("idx_comment_reactions_comment")
		.ifNotExists()
		.on("_emdash_comment_reactions")
		.column("comment_id")
		.execute();

	// Per-voter rate limiting (recent reactions by a voter).
	await db.schema
		.createIndex("idx_comment_reactions_voter")
		.ifNotExists()
		.on("_emdash_comment_reactions")
		.columns(["voter_hash", "created_at"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_comment_reactions").execute();
}
