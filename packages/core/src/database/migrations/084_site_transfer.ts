import { sql, type Kysely, type RawBuilder } from "kysely";

import { isPostgres } from "../dialect-helpers.js";

/**
 * Site transfer (portable export/import) operation state.
 *
 * Operation rows hold digests and small JSON cursors only; manifests, plans,
 * and package files live in staging storage.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_transfer_operations")
		.ifNotExists()
		.addColumn("id", "text", (column) => column.primaryKey())
		.addColumn("kind", "text", (column) => column.notNull())
		.addColumn("state", "text", (column) => column.notNull())
		.addColumn("stage", "text")
		.addColumn("cursor", "text")
		.addColumn("progress", "text")
		.addColumn("options", "text")
		.addColumn("idempotency_key", "text")
		.addColumn("package_digest", "text")
		.addColumn("plan_digest", "text")
		.addColumn("origin_site_id", "text")
		.addColumn("staging_secret", "text", (column) => column.notNull())
		.addColumn("receipt", "text")
		.addColumn("error_code", "text")
		.addColumn("error_detail", "text")
		.addColumn("write_epoch", "integer", (column) => column.notNull().defaultTo(0))
		.addColumn("attempt_count", "integer", (column) => column.notNull().defaultTo(0))
		.addColumn("lease_token", "text")
		.addColumn("lease_expires_at", "text")
		.addColumn("runtime_generation", "integer", (column) => column.notNull().defaultTo(1))
		.addColumn("cancel_requested_at", "text")
		.addColumn("mutation_started_at", "text")
		.addColumn("created_by", "text", (column) => column.notNull())
		.addColumn("created_at", "text", (column) =>
			column.notNull().defaultTo(sortableUtcTimestamp(db)),
		)
		.addColumn("updated_at", "text", (column) =>
			column.notNull().defaultTo(sortableUtcTimestamp(db)),
		)
		.addColumn("completed_at", "text")
		.addColumn("expires_at", "text")
		.addColumn("staging_collected_at", "text")
		.execute();

	await db.schema
		.createIndex("idx__emdash_transfer_operations_idempotency")
		.ifNotExists()
		.unique()
		.on("_emdash_transfer_operations")
		.columns(["created_by", "kind", "idempotency_key"])
		.execute();

	// At most one import may occupy the target: every state before a terminal
	// one, plus failed/cancelled imports that already started writing (they
	// stay fenced until abandoned).
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS idx__emdash_transfer_operations_active_import
		ON _emdash_transfer_operations (kind)
		WHERE kind = 'import'
			AND (
				state IN ('uploading', 'analyzing', 'planned', 'running', 'verifying')
				OR (state IN ('failed', 'cancelled') AND mutation_started_at IS NOT NULL)
			)
	`.execute(db);

	await db.schema
		.createIndex("idx__emdash_transfer_operations_kind_state")
		.ifNotExists()
		.on("_emdash_transfer_operations")
		.columns(["kind", "state", "created_at"])
		.execute();

	await db.schema
		.createIndex("idx__emdash_transfer_operations_expires")
		.ifNotExists()
		.on("_emdash_transfer_operations")
		.columns(["state", "expires_at"])
		.execute();

	await db.schema
		.createIndex("idx__emdash_transfer_operations_uncollected")
		.ifNotExists()
		.on("_emdash_transfer_operations")
		.columns(["staging_collected_at", "state", "updated_at"])
		.execute();

	await db.schema
		.createIndex("idx__emdash_transfer_operations_created_by")
		.ifNotExists()
		.on("_emdash_transfer_operations")
		.column("created_by")
		.execute();

	await db.schema
		.createTable("_emdash_transfer_identity_map")
		.ifNotExists()
		.addColumn("origin_site_id", "text", (column) => column.notNull())
		.addColumn("entity_kind", "text", (column) => column.notNull())
		.addColumn("portable_id", "text", (column) => column.notNull())
		.addColumn("target_id", "text", (column) => column.notNull())
		.addColumn("operation_id", "text", (column) => column.notNull())
		.addColumn("created_at", "text", (column) =>
			column.notNull().defaultTo(sortableUtcTimestamp(db)),
		)
		.addPrimaryKeyConstraint("_emdash_transfer_identity_map_pk", [
			"operation_id",
			"entity_kind",
			"portable_id",
		])
		.execute();

	await db.schema
		.createIndex("idx__emdash_transfer_identity_map_target")
		.ifNotExists()
		.on("_emdash_transfer_identity_map")
		.columns(["operation_id", "entity_kind", "target_id"])
		.execute();

	await db.schema
		.createIndex("idx__emdash_transfer_identity_map_origin")
		.ifNotExists()
		.on("_emdash_transfer_identity_map")
		.columns(["origin_site_id", "entity_kind", "portable_id"])
		.execute();

	await db.schema
		.createTable("_emdash_transfer_staged_files")
		.ifNotExists()
		.addColumn("operation_id", "text", (column) =>
			column.notNull().references("_emdash_transfer_operations.id").onDelete("cascade"),
		)
		.addColumn("path", "text", (column) => column.notNull())
		.addColumn("bytes", "bigint", (column) => column.notNull())
		.addColumn("sha256", "text", (column) => column.notNull())
		.addColumn("state", "text", (column) => column.notNull().defaultTo("declared"))
		.addColumn("verified_at", "text")
		.addColumn("logical_sha256", "text")
		.addPrimaryKeyConstraint("_emdash_transfer_staged_files_pk", ["operation_id", "path"])
		.execute();

	await db.schema
		.createIndex("idx__emdash_transfer_staged_files_state")
		.ifNotExists()
		.on("_emdash_transfer_staged_files")
		.columns(["operation_id", "state", "path"])
		.execute();

	await db.schema
		.createTable("_emdash_transfer_package_index")
		.ifNotExists()
		.addColumn("operation_id", "text", (column) =>
			column.notNull().references("_emdash_transfer_operations.id").onDelete("cascade"),
		)
		.addColumn("kind", "text", (column) => column.notNull())
		.addColumn("id", "text", (column) => column.notNull())
		.addColumn("group_id", "text")
		.addColumn("parent_id", "text")
		.addColumn("name_key", "text")
		.addColumn("depth", "integer", (column) => column.notNull().defaultTo(0))
		.addPrimaryKeyConstraint("_emdash_transfer_package_index_pk", ["operation_id", "kind", "id"])
		.execute();

	await db.schema
		.createIndex("idx__emdash_transfer_package_index_group")
		.ifNotExists()
		.on("_emdash_transfer_package_index")
		.columns(["operation_id", "kind", "group_id"])
		.execute();

	await db.schema
		.createIndex("idx__emdash_transfer_package_index_name")
		.ifNotExists()
		.on("_emdash_transfer_package_index")
		.columns(["operation_id", "kind", "name_key"])
		.execute();

	await db.schema
		.createIndex("idx__emdash_transfer_package_index_parent")
		.ifNotExists()
		.on("_emdash_transfer_package_index")
		.columns(["operation_id", "kind", "parent_id"])
		.execute();

	await db.schema
		.createTable("_emdash_transfer_media_blobs")
		.ifNotExists()
		.addColumn("operation_id", "text", (column) =>
			column.notNull().references("_emdash_transfer_operations.id").onDelete("cascade"),
		)
		.addColumn("media_id", "text", (column) => column.notNull())
		.addColumn("sha256", "text", (column) => column.notNull())
		.addColumn("bytes", "bigint", (column) => column.notNull())
		.addPrimaryKeyConstraint("_emdash_transfer_media_blobs_pk", ["operation_id", "media_id"])
		.execute();

	await db.schema
		.createIndex("idx__emdash_transfer_media_blobs_sha256")
		.ifNotExists()
		.on("_emdash_transfer_media_blobs")
		.columns(["operation_id", "sha256"])
		.execute();

	await db.schema
		.createTable("_emdash_transfer_approvals")
		.ifNotExists()
		.addColumn("id", "text", (column) => column.primaryKey())
		.addColumn("status", "text", (column) => column.notNull().defaultTo("pending"))
		.addColumn("action", "text", (column) => column.notNull())
		.addColumn("user_id", "text", (column) => column.notNull())
		.addColumn("requested_by_token_id", "text")
		.addColumn("approved_by", "text")
		.addColumn("operation_id", "text")
		.addColumn("params_digest", "text")
		.addColumn("package_digest", "text")
		.addColumn("plan_digest", "text")
		.addColumn("expires_at", "text", (column) => column.notNull())
		.addColumn("created_at", "text", (column) =>
			column.notNull().defaultTo(sortableUtcTimestamp(db)),
		)
		.addColumn("decided_at", "text")
		.addColumn("consumed_at", "text")
		.execute();

	await db.schema
		.createIndex("idx__emdash_transfer_approvals_user_status")
		.ifNotExists()
		.on("_emdash_transfer_approvals")
		.columns(["user_id", "status", "created_at"])
		.execute();

	await db.schema
		.createIndex("idx__emdash_transfer_approvals_status_created")
		.ifNotExists()
		.on("_emdash_transfer_approvals")
		.columns(["status", "created_at", "id"])
		.execute();

	await db.schema
		.createIndex("idx__emdash_transfer_approvals_operation")
		.ifNotExists()
		.on("_emdash_transfer_approvals")
		.column("operation_id")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_transfer_approvals").ifExists().execute();
	await db.schema.dropTable("_emdash_transfer_media_blobs").ifExists().execute();
	await db.schema.dropTable("_emdash_transfer_package_index").ifExists().execute();
	await db.schema.dropTable("_emdash_transfer_staged_files").ifExists().execute();
	await db.schema.dropTable("_emdash_transfer_identity_map").ifExists().execute();
	await db.schema.dropTable("_emdash_transfer_operations").ifExists().execute();
}

function sortableUtcTimestamp(db: Kysely<unknown>): RawBuilder<string> {
	if (isPostgres(db)) {
		return sql`to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
	}
	return sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
}
