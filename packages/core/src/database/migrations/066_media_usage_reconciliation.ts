import { sql, type Kysely, type RawBuilder } from "kysely";

import { columnExists, isPostgres, tableExists } from "../dialect-helpers.js";

const ACTIVATION_KEY = "incremental_capture";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_media_usage_reconciliations")
		.ifNotExists()
		.addColumn("collection_id", "text", (column) => column.notNull().primaryKey())
		.addColumn("collection_slug", "text", (column) => column.notNull())
		.addColumn("run_token", "text", (column) => column.notNull())
		.addColumn("target_epoch", "bigint")
		.addColumn("field_fingerprint", "text")
		.addColumn("state", "text", (column) => column.notNull().defaultTo("pending"))
		.addColumn("phase", "text", (column) => column.notNull().defaultTo("scan"))
		.addColumn("scan_cursor", "text")
		.addColumn("scan_upper_id", "text")
		.addColumn("source_cursor", "text")
		.addColumn("source_upper_key", "text")
		.addColumn("attempt_count", "integer", (column) => column.notNull().defaultTo(0))
		.addColumn("next_attempt_at", "text", (column) => column.notNull())
		.addColumn("lease_token", "text")
		.addColumn("lease_expires_at", "text")
		.addColumn("last_error_code", "text")
		.addColumn("created_at", "text", (column) =>
			column.notNull().defaultTo(sortableUtcTimestamp(db)),
		)
		.addColumn("updated_at", "text", (column) =>
			column.notNull().defaultTo(sortableUtcTimestamp(db)),
		)
		.execute();

	await db.schema
		.createIndex("idx__emdash_media_usage_reconciliations_due")
		.ifNotExists()
		.on("_emdash_media_usage_reconciliations")
		.columns(["state", "next_attempt_at", "updated_at", "collection_id"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_reconciliations_lease")
		.ifNotExists()
		.on("_emdash_media_usage_reconciliations")
		.columns(["state", "lease_expires_at", "updated_at", "collection_id"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_reconciliations_failed")
		.ifNotExists()
		.on("_emdash_media_usage_reconciliations")
		.columns(["state", "updated_at", "collection_id"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_status_reconciliation")
		.ifNotExists()
		.on("_emdash_media_usage_index_status")
		.columns([
			"adapter_id",
			"scope_type",
			"capture_state",
			"reconciliation_required",
			"collection_id",
		])
		.execute();

	if (!(await columnExists(db, "_emdash_media_usage_activation", "media_usage_maintenance_turn"))) {
		await db.schema
			.alterTable("_emdash_media_usage_activation")
			.addColumn("media_usage_maintenance_turn", "integer", (column) =>
				column.notNull().defaultTo(2),
			)
			.execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (await tableExists(db, "_emdash_media_usage_reconciliations")) {
		const evidence = await sql<{ present: number }>`
			SELECT 1 AS present
			FROM _emdash_media_usage_reconciliations
			LIMIT 1
		`.execute(db);
		if (evidence.rows.length > 0) {
			throw new Error("Cannot roll back while durable reconciliation evidence exists");
		}
	}

	const activation = await sql<{ state: string }>`
		SELECT state
		FROM _emdash_media_usage_activation
		WHERE task_key = ${ACTIVATION_KEY}
	`.execute(db);
	if (activation.rows[0]?.state !== "expanded") {
		throw new Error("Cannot roll back media usage reconciliation after activation has started");
	}

	await db.schema.dropIndex("idx__emdash_media_usage_status_reconciliation").ifExists().execute();
	await db.schema.dropIndex("idx__emdash_media_usage_reconciliations_failed").ifExists().execute();
	await db.schema.dropIndex("idx__emdash_media_usage_reconciliations_lease").ifExists().execute();
	await db.schema.dropIndex("idx__emdash_media_usage_reconciliations_due").ifExists().execute();
	await db.schema.dropTable("_emdash_media_usage_reconciliations").ifExists().execute();
	if (await columnExists(db, "_emdash_media_usage_activation", "media_usage_maintenance_turn")) {
		await db.schema
			.alterTable("_emdash_media_usage_activation")
			.dropColumn("media_usage_maintenance_turn")
			.execute();
	}
}

function sortableUtcTimestamp(db: Kysely<unknown>): RawBuilder<string> {
	if (isPostgres(db)) {
		return sql`to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
	}
	return sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
}
