import type { Kysely } from "kysely";

import { binaryType } from "../dialect-helpers.js";

/**
 * Migration: room storage for co-editing on Node.js.
 *
 * `_emdash_rooms` holds each room's record, split into parts. Part 0 also
 * holds the room's claim and the time of its last write. `_emdash_room_updates`
 * holds its updates and compacted state, also split into parts.
 *
 * Timestamps carry no column default: `datetime('now')` renders a
 * space-separated shape that would not sort against the ISO-8601 values the
 * claim predicates compare as strings.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_rooms")
		.ifNotExists()
		.addColumn("room_id", "text", (col) => col.notNull())
		.addColumn("part", "integer", (col) => col.notNull())
		.addColumn("record", "text")
		.addColumn("host", "text")
		.addColumn("claimed_at", "text")
		.addColumn("updated_at", "text", (col) => col.notNull())
		.addPrimaryKeyConstraint("pk_emdash_rooms", ["room_id", "part"])
		.execute();

	await db.schema
		.createTable("_emdash_room_updates")
		.ifNotExists()
		.addColumn("room_id", "text", (col) => col.notNull())
		.addColumn("seq", "integer", (col) => col.notNull())
		.addColumn("part", "integer", (col) => col.notNull())
		.addColumn("data", binaryType(db), (col) => col.notNull())
		.addPrimaryKeyConstraint("pk_emdash_room_updates", ["room_id", "seq", "part"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_room_updates").ifExists().execute();
	await db.schema.dropTable("_emdash_rooms").ifExists().execute();
}
