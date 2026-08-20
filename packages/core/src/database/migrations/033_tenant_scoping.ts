import type { Kysely } from "kysely";

import { currentTimestamp } from "../dialect-helpers.js";

/**
 * Add tenant_id columns for multi-tenant support
 *
 * opng.in uses emdash as a shared rendering engine serving multiple tenants.
 * This migration adds tenant_id foreign key to all content tables for strict isolation.
 *
 * Backward compatibility: DEFAULT 'default' allows existing single-tenant data to work unchanged.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	// Revisions table - track tenant for revision history
	try {
		await db.schema
			.alterTable("revisions")
			.addColumn("tenant_id", "text", (col) => col.notNull().defaultTo("default"))
			.execute();

		await db.schema
			.createIndex("idx_revisions_tenant_id")
			.ifNotExists()
			.on("revisions")
			.column("tenant_id")
			.execute();
	} catch {
		// Column may already exist
	}

	// Taxonomies - each taxonomy belongs to a tenant
	try {
		await db.schema
			.alterTable("taxonomies")
			.addColumn("tenant_id", "text", (col) => col.notNull().defaultTo("default"))
			.execute();

		await db.schema
			.createIndex("idx_taxonomies_tenant_id")
			.ifNotExists()
			.on("taxonomies")
			.column("tenant_id")
			.execute();
	} catch {
		// Column may already exist
	}

	// Content-Taxonomy junction - tenant scoped
	try {
		await db.schema
			.alterTable("content_taxonomies")
			.addColumn("tenant_id", "text", (col) => col.notNull().defaultTo("default"))
			.execute();

		await db.schema
			.createIndex("idx_content_taxonomies_tenant_id")
			.ifNotExists()
			.on("content_taxonomies")
			.column("tenant_id")
			.execute();
	} catch {
		// Column may already exist
	}

	// Media files - tenant scoped storage
	try {
		await db.schema
			.alterTable("media")
			.addColumn("tenant_id", "text", (col) => col.notNull().defaultTo("default"))
			.execute();

		await db.schema
			.createIndex("idx_media_tenant_id")
			.ifNotExists()
			.on("media")
			.column("tenant_id")
			.execute();
	} catch {
		// Column may already exist
	}

	// Audit logs - track tenant for security events
	try {
		await db.schema
			.alterTable("audit_logs")
			.addColumn("tenant_id", "text", (col) => col.notNull().defaultTo("default"))
			.execute();

		await db.schema
			.createIndex("idx_audit_logs_tenant_id")
			.ifNotExists()
			.on("audit_logs")
			.column("tenant_id")
			.execute();
	} catch {
		// Column may already exist
	}

	// _emdash_collections - system table for collection definitions
	try {
		await db.schema
			.alterTable("_emdash_collections")
			.addColumn("tenant_id", "text", (col) => col.notNull().defaultTo("default"))
			.execute();

		await db.schema
			.createIndex("idx_emdash_collections_tenant_id")
			.ifNotExists()
			.on("_emdash_collections")
			.column("tenant_id")
			.execute();
	} catch {
		// Column may already exist
	}

	// _emdash_fields - system table for field definitions
	try {
		await db.schema
			.alterTable("_emdash_fields")
			.addColumn("tenant_id", "text", (col) => col.notNull().defaultTo("default"))
			.execute();

		await db.schema
			.createIndex("idx_emdash_fields_tenant_id")
			.ifNotExists()
			.on("_emdash_fields")
			.column("tenant_id")
			.execute();
	} catch {
		// Column may already exist
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// Drop indexes
	const indexes = [
		"idx_revisions_tenant_id",
		"idx_taxonomies_tenant_id",
		"idx_content_taxonomies_tenant_id",
		"idx_media_tenant_id",
		"idx_audit_logs_tenant_id",
		"idx_emdash_collections_tenant_id",
		"idx_emdash_fields_tenant_id",
	];

	for (const indexName of indexes) {
		try {
			await db.schema.dropIndex(indexName).execute();
		} catch {
			// Index may not exist
		}
	}

	// Drop columns
	const tables = [
		"revisions",
		"taxonomies",
		"content_taxonomies",
		"media",
		"audit_logs",
		"_emdash_collections",
		"_emdash_fields",
	];

	for (const tableName of tables) {
		try {
			await db.schema
				.alterTable(tableName)
				.dropColumn("tenant_id")
				.execute();
		} catch {
			// Column may not exist
		}
	}
}
