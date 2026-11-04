import type { Kysely } from "kysely";

import { columnExists, currentTimestamp } from "../dialect-helpers.js";

const SOURCE_TABLE = "_emdash_media_usage_sources";
const DUPLICATE_COLUMN_RE = /(?:duplicate column|column .* already exists|already exists.*column)/i;

/**
 * Media usage index metadata.
 *
 * DDL-only by design: adds freshness/completeness metadata and scope status
 * tracking for later reference-index reconciliation. No content scans, no
 * runtime imports, and no backfill.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await addSourceMetadataColumns(db);

	await db.schema
		.createTable("_emdash_media_usage_index_status")
		.ifNotExists()
		.addColumn("adapter_id", "text", (c) => c.notNull())
		.addColumn("scope_type", "text", (c) => c.notNull())
		.addColumn("scope_key", "text", (c) => c.notNull())
		.addColumn("status", "text", (c) => c.notNull())
		.addColumn("schema_version", "integer", (c) => c.notNull().defaultTo(1))
		.addColumn("started_at", "text")
		.addColumn("completed_at", "text")
		.addColumn("cursor", "text")
		.addColumn("indexed_source_count", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("failed_source_count", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("last_error_code", "text")
		.addColumn("updated_at", "text", (c) => c.notNull().defaultTo(currentTimestamp(db)))
		.addPrimaryKeyConstraint("_emdash_media_usage_index_status_pk", [
			"adapter_id",
			"scope_type",
			"scope_key",
		])
		.execute();

	await db.schema
		.createIndex("idx__emdash_media_usage_sources_completeness")
		.ifNotExists()
		.on("_emdash_media_usage_sources")
		.columns(["source_type", "collection_slug", "source_completeness"])
		.execute();

	await db.schema
		.createIndex("idx__emdash_media_usage_sources_fingerprint")
		.ifNotExists()
		.on("_emdash_media_usage_sources")
		.column("source_fingerprint")
		.execute();

	await db.schema
		.createIndex("idx__emdash_media_usage_index_status_status")
		.ifNotExists()
		.on("_emdash_media_usage_index_status")
		.columns(["adapter_id", "status"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("idx__emdash_media_usage_index_status_status").ifExists().execute();
	await db.schema.dropIndex("idx__emdash_media_usage_sources_fingerprint").ifExists().execute();
	await db.schema.dropIndex("idx__emdash_media_usage_sources_completeness").ifExists().execute();
	await db.schema.dropTable("_emdash_media_usage_index_status").ifExists().execute();

	await dropSourceMetadataColumns(db);
}

async function addSourceMetadataColumns(db: Kysely<unknown>): Promise<void> {
	await addColumnIfMissing(db, "source_updated_at", () =>
		db.schema.alterTable(SOURCE_TABLE).addColumn("source_updated_at", "text").execute(),
	);
	await addColumnIfMissing(db, "source_version", () =>
		db.schema.alterTable(SOURCE_TABLE).addColumn("source_version", "integer").execute(),
	);
	await addColumnIfMissing(db, "source_fingerprint", () =>
		db.schema.alterTable(SOURCE_TABLE).addColumn("source_fingerprint", "text").execute(),
	);
	await addColumnIfMissing(db, "source_completeness", () =>
		db.schema
			.alterTable(SOURCE_TABLE)
			.addColumn("source_completeness", "text", (c) => c.notNull().defaultTo("unknown"))
			.execute(),
	);
	await addColumnIfMissing(db, "last_attempted_at", () =>
		db.schema.alterTable(SOURCE_TABLE).addColumn("last_attempted_at", "text").execute(),
	);
	await addColumnIfMissing(db, "last_error_code", () =>
		db.schema.alterTable(SOURCE_TABLE).addColumn("last_error_code", "text").execute(),
	);
}

async function addColumnIfMissing(
	db: Kysely<unknown>,
	columnName: string,
	addColumn: () => Promise<void>,
): Promise<void> {
	if (await columnExists(db, SOURCE_TABLE, columnName)) return;

	try {
		await addColumn();
	} catch (error) {
		if (DUPLICATE_COLUMN_RE.test(deepErrorMessage(error))) {
			if (await columnExists(db, SOURCE_TABLE, columnName)) return;
		}
		throw error;
	}
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

async function dropSourceMetadataColumns(db: Kysely<unknown>): Promise<void> {
	for (const columnName of [
		"last_error_code",
		"last_attempted_at",
		"source_completeness",
		"source_fingerprint",
		"source_version",
		"source_updated_at",
	] as const) {
		if (await columnExists(db, SOURCE_TABLE, columnName)) {
			await db.schema.alterTable(SOURCE_TABLE).dropColumn(columnName).execute();
		}
	}
}
