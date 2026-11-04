import { sql, type Kysely, type RawBuilder } from "kysely";

import { columnExists, isPostgres, tableExists } from "../dialect-helpers.js";

const ACTIVATION_KEY = "incremental_capture";
const CONTENT_ADAPTER_ID = "content-media";
const COLLECTION_SCOPE = "collection";
const DUPLICATE_COLUMN_RE = /(?:duplicate column|column .* already exists|already exists.*column)/i;

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_media_usage_activation")
		.ifNotExists()
		.addColumn("task_key", "text", (column) => column.primaryKey())
		.addColumn("state", "text", (column) => column.notNull().defaultTo("expanded"))
		.addColumn("runtime_generation", "integer", (column) => column.notNull().defaultTo(1))
		.addColumn("collection_cursor", "text")
		.addColumn("drain_confirmed_at", "text")
		.addColumn("lease_token", "text")
		.addColumn("lease_expires_at", "text")
		.addColumn("attempt_count", "integer", (column) => column.notNull().defaultTo(0))
		.addColumn("last_attempted_at", "text")
		.addColumn("last_error_code", "text")
		.addColumn("activated_at", "text")
		.addColumn("created_at", "text", (column) =>
			column.notNull().defaultTo(sortableUtcTimestamp(db)),
		)
		.addColumn("updated_at", "text", (column) =>
			column.notNull().defaultTo(sortableUtcTimestamp(db)),
		)
		.execute();

	await sql`
		INSERT INTO _emdash_media_usage_activation (task_key, state)
		VALUES (${ACTIVATION_KEY}, 'expanded')
		ON CONFLICT (task_key) DO NOTHING
	`.execute(db);

	await db.schema
		.createTable("_emdash_media_usage_work")
		.ifNotExists()
		.addColumn("collection_id", "text", (column) => column.notNull())
		.addColumn("collection_slug", "text", (column) => column.notNull())
		.addColumn("content_id", "text", (column) => column.notNull())
		.addColumn("change_epoch", "bigint", (column) => column.notNull())
		.addColumn("work_version", "bigint", (column) => column.notNull().defaultTo(1))
		.addColumn("state", "text", (column) => column.notNull().defaultTo("pending"))
		.addColumn("attempt_count", "integer", (column) => column.notNull().defaultTo(0))
		.addColumn("next_attempt_at", "text", (column) => column.notNull())
		.addColumn("lease_token", "text")
		.addColumn("lease_expires_at", "text")
		.addColumn("last_attempted_at", "text")
		.addColumn("last_error_code", "text")
		.addColumn("created_at", "text", (column) =>
			column.notNull().defaultTo(sortableUtcTimestamp(db)),
		)
		.addColumn("updated_at", "text", (column) =>
			column.notNull().defaultTo(sortableUtcTimestamp(db)),
		)
		.addPrimaryKeyConstraint("_emdash_media_usage_work_pk", ["collection_id", "content_id"])
		.execute();

	await addStatusColumns(db);
	await addSourceColumns(db);

	await db.schema
		.createIndex("idx__emdash_media_usage_work_due")
		.ifNotExists()
		.on("_emdash_media_usage_work")
		.columns(["state", "next_attempt_at", "updated_at", "collection_id", "content_id"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_work_lease")
		.ifNotExists()
		.on("_emdash_media_usage_work")
		.columns(["state", "lease_expires_at", "collection_id", "content_id"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_work_operator")
		.ifNotExists()
		.on("_emdash_media_usage_work")
		.columns(["collection_id", "state", "updated_at", "content_id"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_status_collection")
		.ifNotExists()
		.unique()
		.on("_emdash_media_usage_index_status")
		.columns(["adapter_id", "scope_type", "collection_id"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_sources_identity")
		.ifNotExists()
		.on("_emdash_media_usage_sources")
		.columns(["source_type", "collection_id", "content_id", "source_variant"])
		.execute();

	await sql`
		DELETE FROM _emdash_media_usage_index_status
		WHERE adapter_id = ${CONTENT_ADAPTER_ID}
			AND scope_type = ${COLLECTION_SCOPE}
			AND (
				(
					collection_id IS NULL
					AND NOT EXISTS (
						SELECT 1
						FROM _emdash_collections AS collection
						WHERE collection.slug = _emdash_media_usage_index_status.scope_key
					)
				)
				OR (
					collection_id IS NOT NULL
					AND capture_state = 'installing'
					AND EXISTS (
						SELECT 1
						FROM _emdash_media_usage_activation AS activation
						WHERE activation.task_key = ${ACTIVATION_KEY}
							AND activation.state = 'expanded'
					)
					AND NOT EXISTS (
						SELECT 1
						FROM _emdash_collections AS collection
						WHERE collection.id = _emdash_media_usage_index_status.collection_id
							AND collection.slug = _emdash_media_usage_index_status.scope_key
					)
				)
			)
	`.execute(db);

	await sql`
		UPDATE _emdash_media_usage_index_status
		SET collection_id = (
				SELECT collection.id
				FROM _emdash_collections AS collection
				WHERE collection.slug = _emdash_media_usage_index_status.scope_key
			),
			reconciliation_required = 1,
			capture_state = COALESCE(capture_state, 'installing')
		WHERE adapter_id = ${CONTENT_ADAPTER_ID}
			AND scope_type = ${COLLECTION_SCOPE}
			AND (
				collection_id IS NULL
				OR capture_state IS NULL
			)
			AND EXISTS (
				SELECT 1
				FROM _emdash_collections AS collection
				WHERE collection.id = COALESCE(
					_emdash_media_usage_index_status.collection_id,
					collection.id
				)
					AND collection.slug = _emdash_media_usage_index_status.scope_key
			)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await assertRollbackIsEmptyAndInactive(db);

	await db.schema.dropIndex("idx__emdash_media_usage_sources_identity").ifExists().execute();
	await db.schema.dropIndex("idx__emdash_media_usage_status_collection").ifExists().execute();
	await db.schema.dropIndex("idx__emdash_media_usage_work_operator").ifExists().execute();
	await db.schema.dropIndex("idx__emdash_media_usage_work_lease").ifExists().execute();
	await db.schema.dropIndex("idx__emdash_media_usage_work_due").ifExists().execute();
	await db.schema.dropTable("_emdash_media_usage_work").ifExists().execute();
	await db.schema.dropTable("_emdash_media_usage_activation").ifExists().execute();
	if (isPostgres(db)) {
		await sql`DROP FUNCTION IF EXISTS emdash_media_usage_capture_work()`.execute(db);
	}

	for (const columnName of ["identity_version", "collection_id"] as const) {
		if (await columnExists(db, "_emdash_media_usage_sources", columnName)) {
			await db.schema.alterTable("_emdash_media_usage_sources").dropColumn(columnName).execute();
		}
	}

	for (const columnName of [
		"capture_state",
		"last_incremental_success_at",
		"reconciliation_required",
		"change_epoch",
		"collection_id",
	] as const) {
		if (await columnExists(db, "_emdash_media_usage_index_status", columnName)) {
			await db.schema
				.alterTable("_emdash_media_usage_index_status")
				.dropColumn(columnName)
				.execute();
		}
	}
}

async function addStatusColumns(db: Kysely<unknown>): Promise<void> {
	await addColumnIfMissing(db, "_emdash_media_usage_index_status", "collection_id", () =>
		db.schema
			.alterTable("_emdash_media_usage_index_status")
			.addColumn("collection_id", "text")
			.execute(),
	);
	await addColumnIfMissing(db, "_emdash_media_usage_index_status", "change_epoch", () =>
		db.schema
			.alterTable("_emdash_media_usage_index_status")
			.addColumn("change_epoch", "bigint", (column) => column.notNull().defaultTo(0))
			.execute(),
	);
	await addColumnIfMissing(db, "_emdash_media_usage_index_status", "reconciliation_required", () =>
		db.schema
			.alterTable("_emdash_media_usage_index_status")
			.addColumn("reconciliation_required", "integer", (column) => column.notNull().defaultTo(0))
			.execute(),
	);
	await addStatusTextColumn(db, "last_incremental_success_at");
	await addStatusTextColumn(db, "capture_state");
}

async function assertRollbackIsEmptyAndInactive(db: Kysely<unknown>): Promise<void> {
	if (await hasCaptureTriggers(db)) {
		throw new Error("Cannot roll back media usage capture while capture triggers are installed");
	}

	if (await tableExists(db, "_emdash_media_usage_activation")) {
		const activation = await sql<{ state: string }>`
			SELECT state
			FROM _emdash_media_usage_activation
			WHERE task_key = ${ACTIVATION_KEY}
		`.execute(db);
		if (activation.rows[0] && activation.rows[0].state !== "expanded") {
			throw new Error("Cannot roll back media usage capture after activation has started");
		}
	}

	if (await tableExists(db, "_emdash_media_usage_work")) {
		const work = await sql<{ present: number }>`
			SELECT 1 AS present FROM _emdash_media_usage_work LIMIT 1
		`.execute(db);
		if (work.rows.length > 0) {
			throw new Error("Cannot roll back media usage capture while durable work exists");
		}
	}

	const sourceHasCollectionId = await columnExists(
		db,
		"_emdash_media_usage_sources",
		"collection_id",
	);
	const sourceHasIdentityVersion = await columnExists(
		db,
		"_emdash_media_usage_sources",
		"identity_version",
	);
	if (sourceHasCollectionId || sourceHasIdentityVersion) {
		const canonicalSources = sourceHasCollectionId
			? await sql<{ present: number }>`
					SELECT 1 AS present
					FROM _emdash_media_usage_sources
					WHERE collection_id IS NOT NULL
					LIMIT 1
				`.execute(db)
			: await sql<{ present: number }>`
					SELECT 1 AS present
					FROM _emdash_media_usage_sources
					WHERE identity_version IS NOT NULL
					LIMIT 1
				`.execute(db);
		if (canonicalSources.rows.length > 0) {
			throw new Error("Cannot roll back media usage capture after canonical sources exist");
		}
		if (sourceHasCollectionId && sourceHasIdentityVersion) {
			const versionedSources = await sql<{ present: number }>`
				SELECT 1 AS present
				FROM _emdash_media_usage_sources
				WHERE identity_version IS NOT NULL
				LIMIT 1
			`.execute(db);
			if (versionedSources.rows.length > 0) {
				throw new Error("Cannot roll back media usage capture after canonical sources exist");
			}
		}
	}

	if (await columnExists(db, "_emdash_media_usage_index_status", "capture_state")) {
		const lifecycle = await sql<{ present: number }>`
			SELECT 1 AS present FROM _emdash_media_usage_index_status
			WHERE capture_state IN ('active', 'deleting') LIMIT 1
		`.execute(db);
		if (lifecycle.rows.length > 0) throwRollbackLifecycleError();
	}
	if (await columnExists(db, "_emdash_media_usage_index_status", "change_epoch")) {
		const epoch = await sql<{ present: number }>`
			SELECT 1 AS present FROM _emdash_media_usage_index_status
			WHERE change_epoch <> 0 LIMIT 1
		`.execute(db);
		if (epoch.rows.length > 0) throwRollbackLifecycleError();
	}
	if (await columnExists(db, "_emdash_media_usage_index_status", "last_incremental_success_at")) {
		const success = await sql<{ present: number }>`
			SELECT 1 AS present FROM _emdash_media_usage_index_status
			WHERE last_incremental_success_at IS NOT NULL LIMIT 1
		`.execute(db);
		if (success.rows.length > 0) throwRollbackLifecycleError();
	}
}

function throwRollbackLifecycleError(): never {
	throw new Error("Cannot roll back media usage capture while capture lifecycle state exists");
}

async function hasCaptureTriggers(db: Kysely<unknown>): Promise<boolean> {
	if (isPostgres(db)) {
		const result = await sql<{ present: boolean }>`
			SELECT EXISTS (
				SELECT 1
				FROM pg_trigger AS trigger
				INNER JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
				INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
				WHERE namespace.nspname = current_schema()
					AND NOT trigger.tgisinternal
					AND left(trigger.tgname, 10) = 'emdash_mu_'
			) AS present
		`.execute(db);
		return result.rows[0]?.present === true;
	}

	const result = await sql<{ present: number }>`
		SELECT 1 AS present
		FROM sqlite_master
		WHERE type = 'trigger' AND substr(name, 1, 10) = 'emdash_mu_'
		LIMIT 1
	`.execute(db);
	return result.rows.length > 0;
}

async function addStatusTextColumn(db: Kysely<unknown>, columnName: string): Promise<void> {
	await addColumnIfMissing(db, "_emdash_media_usage_index_status", columnName, () =>
		db.schema
			.alterTable("_emdash_media_usage_index_status")
			.addColumn(columnName, "text")
			.execute(),
	);
}

async function addSourceColumns(db: Kysely<unknown>): Promise<void> {
	await addColumnIfMissing(db, "_emdash_media_usage_sources", "collection_id", () =>
		db.schema
			.alterTable("_emdash_media_usage_sources")
			.addColumn("collection_id", "text")
			.execute(),
	);
	await addColumnIfMissing(db, "_emdash_media_usage_sources", "identity_version", () =>
		db.schema
			.alterTable("_emdash_media_usage_sources")
			.addColumn("identity_version", "integer")
			.execute(),
	);
}

async function addColumnIfMissing(
	db: Kysely<unknown>,
	tableName: string,
	columnName: string,
	addColumn: () => Promise<void>,
): Promise<void> {
	if (await columnExists(db, tableName, columnName)) return;

	try {
		await addColumn();
	} catch (error) {
		if (DUPLICATE_COLUMN_RE.test(deepErrorMessage(error))) {
			if (await columnExists(db, tableName, columnName)) return;
		}
		throw error;
	}
}

function sortableUtcTimestamp(db: Kysely<unknown>): RawBuilder<string> {
	if (isPostgres(db)) {
		return sql`to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
	}
	return sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
}

function deepErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		const own = error.message ?? "";
		if (error.cause) {
			const causeMessage = deepErrorMessage(error.cause);
			return own ? `${own}: ${causeMessage}` : causeMessage;
		}
		return own;
	}
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}
