import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const EXPECTED_SOURCE_COLUMNS = [
	"source_updated_at",
	"source_version",
	"source_fingerprint",
	"source_completeness",
	"last_attempted_at",
	"last_error_code",
] as const;

const EXPECTED_STATUS_COLUMNS = [
	"adapter_id",
	"scope_type",
	"scope_key",
	"status",
	"schema_version",
	"started_at",
	"completed_at",
	"cursor",
	"indexed_source_count",
	"failed_source_count",
	"last_error_code",
	"updated_at",
] as const;

const EXPECTED_INDEXES = [
	"idx__emdash_media_usage_sources_completeness",
	"idx__emdash_media_usage_sources_fingerprint",
	"idx__emdash_media_usage_index_status_status",
] as const;

describeEachDialect("media usage index status migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("is registered and creates metadata columns plus status table", async () => {
		const migrations = await ctx.db.selectFrom("_emdash_migrations").select("name").execute();
		expect(migrations.map((row) => row.name)).toContain("050_media_usage_index_status");

		const sourceColumns = await listColumnNames(ctx, "_emdash_media_usage_sources");
		for (const columnName of EXPECTED_SOURCE_COLUMNS) {
			expect(sourceColumns.has(columnName), `missing source column ${columnName}`).toBe(true);
		}

		const statusColumns = await listColumnNames(ctx, "_emdash_media_usage_index_status");
		for (const columnName of EXPECTED_STATUS_COLUMNS) {
			expect(statusColumns.has(columnName), `missing status column ${columnName}`).toBe(true);
		}
	});

	it("applies defaults for source completeness and status counters", async () => {
		await ctx.db
			.insertInto("_emdash_media_usage_sources")
			.values({
				source_key: "content:posts:entry1:columns",
				source_type: "content",
				collection_slug: "posts",
				content_id: "entry1",
				source_variant: "columns",
				locale: "en",
				translation_group: "tg1",
				content_slug: "hello-world",
				content_title: "Hello World",
				content_status: "published",
				content_scheduled_at: null,
				content_deleted_at: null,
				revision_id: "rev1",
				current_generation: "gen1",
			})
			.execute();

		const source = await ctx.db
			.selectFrom("_emdash_media_usage_sources")
			.select([
				"source_completeness",
				"source_updated_at",
				"source_version",
				"source_fingerprint",
				"last_attempted_at",
				"last_error_code",
			])
			.where("source_key", "=", "content:posts:entry1:columns")
			.executeTakeFirstOrThrow();

		expect(source).toEqual({
			source_completeness: "unknown",
			source_updated_at: null,
			source_version: null,
			source_fingerprint: null,
			last_attempted_at: null,
			last_error_code: null,
		});

		await ctx.db
			.insertInto("_emdash_media_usage_index_status")
			.values({
				adapter_id: "content-media",
				scope_type: "collection",
				scope_key: "posts",
				status: "never",
			})
			.execute();

		const status = await ctx.db
			.selectFrom("_emdash_media_usage_index_status")
			.select([
				"schema_version",
				"indexed_source_count",
				"failed_source_count",
				"started_at",
				"completed_at",
				"cursor",
				"last_error_code",
				"updated_at",
			])
			.where("adapter_id", "=", "content-media")
			.where("scope_type", "=", "collection")
			.where("scope_key", "=", "posts")
			.executeTakeFirstOrThrow();

		expect(status).toEqual({
			schema_version: 1,
			indexed_source_count: 0,
			failed_source_count: 0,
			started_at: null,
			completed_at: null,
			cursor: null,
			last_error_code: null,
			updated_at: expect.any(String),
		});
	});

	it("rejects duplicate status rows for the same adapter scope", async () => {
		await ctx.db
			.insertInto("_emdash_media_usage_index_status")
			.values({
				adapter_id: "content-media",
				scope_type: "collection",
				scope_key: "posts",
				status: "running",
			})
			.execute();

		await expect(
			ctx.db
				.insertInto("_emdash_media_usage_index_status")
				.values({
					adapter_id: "content-media",
					scope_type: "collection",
					scope_key: "posts",
					status: "complete",
				})
				.execute(),
		).rejects.toThrow();
	});

	it("adds source completeness default for existing PR 1 source rows", async () => {
		const migration =
			await import("../../../src/database/migrations/050_media_usage_index_status.js");
		const sourceKey = "content:posts:pre047:columns";

		await migration.down(ctx.db);

		await ctx.db
			.insertInto("_emdash_media_usage_sources")
			.values({
				source_key: sourceKey,
				source_type: "content",
				collection_slug: "posts",
				content_id: "pre047",
				source_variant: "columns",
				locale: "en",
				translation_group: "tg-pre047",
				content_slug: "pre047",
				content_title: "Pre 047",
				content_status: "published",
				content_scheduled_at: null,
				content_deleted_at: null,
				revision_id: "rev-pre047",
				current_generation: "gen-pre047",
			})
			.execute();

		await migration.up(ctx.db);

		const source = await ctx.db
			.selectFrom("_emdash_media_usage_sources")
			.select([
				"source_completeness",
				"source_updated_at",
				"source_version",
				"source_fingerprint",
				"last_attempted_at",
				"last_error_code",
			])
			.where("source_key", "=", sourceKey)
			.executeTakeFirstOrThrow();

		expect(source).toEqual({
			source_completeness: "unknown",
			source_updated_at: null,
			source_version: null,
			source_fingerprint: null,
			last_attempted_at: null,
			last_error_code: null,
		});
	});

	it("creates expected indexes", async () => {
		const indexNames = await listIndexNames(ctx);

		for (const indexName of EXPECTED_INDEXES) {
			expect(indexNames.has(indexName), `missing index ${indexName}`).toBe(true);
		}
	});

	it("up() can run again after registered migrations complete", async () => {
		const migration =
			await import("../../../src/database/migrations/050_media_usage_index_status.js");
		const sourceKey = "content:posts:entry-preserve:columns";
		const sourceMetadata = {
			source_completeness: "complete",
			source_updated_at: "2026-01-01T00:00:00.000Z",
			source_version: 7,
			source_fingerprint: "fingerprint-preserve",
			last_attempted_at: "2026-01-01T00:00:01.000Z",
			last_error_code: "PREVIOUS_ERROR",
		};

		await ctx.db
			.insertInto("_emdash_media_usage_sources")
			.values({
				source_key: sourceKey,
				source_type: "content",
				collection_slug: "posts",
				content_id: "entry-preserve",
				source_variant: "columns",
				locale: "en",
				translation_group: "tg-preserve",
				content_slug: "preserve",
				content_title: "Preserve",
				content_status: "published",
				content_scheduled_at: null,
				content_deleted_at: null,
				revision_id: "rev-preserve",
				current_generation: "gen-preserve",
				...sourceMetadata,
			})
			.execute();

		const statusMetadata = {
			schema_version: 3,
			started_at: "2026-01-02T00:00:00.000Z",
			completed_at: "2026-01-02T00:00:10.000Z",
			cursor: "cursor-preserve",
			indexed_source_count: 12,
			failed_source_count: 2,
			last_error_code: "STATUS_ERROR",
			updated_at: "2026-01-02T00:00:11.000Z",
		};

		await ctx.db
			.insertInto("_emdash_media_usage_index_status")
			.values({
				adapter_id: "content-media",
				scope_type: "collection",
				scope_key: "posts",
				status: "partial",
				...statusMetadata,
			})
			.execute();

		await migration.up(ctx.db);

		const statusColumns = await listColumnNames(ctx, "_emdash_media_usage_index_status");
		expect(statusColumns.has("adapter_id")).toBe(true);

		const source = await ctx.db
			.selectFrom("_emdash_media_usage_sources")
			.select([
				"source_completeness",
				"source_updated_at",
				"source_version",
				"source_fingerprint",
				"last_attempted_at",
				"last_error_code",
			])
			.where("source_key", "=", sourceKey)
			.executeTakeFirstOrThrow();
		expect(source).toEqual(sourceMetadata);

		const status = await ctx.db
			.selectFrom("_emdash_media_usage_index_status")
			.select([
				"status",
				"schema_version",
				"started_at",
				"completed_at",
				"cursor",
				"indexed_source_count",
				"failed_source_count",
				"last_error_code",
				"updated_at",
			])
			.where("adapter_id", "=", "content-media")
			.where("scope_type", "=", "collection")
			.where("scope_key", "=", "posts")
			.executeTakeFirstOrThrow();
		expect(status).toEqual({ status: "partial", ...statusMetadata });
	});

	it("down() drops metadata and up() recreates it", async () => {
		const migration =
			await import("../../../src/database/migrations/050_media_usage_index_status.js");

		await migration.down(ctx.db);

		await expect(
			sql`SELECT 1 FROM _emdash_media_usage_index_status`.execute(ctx.db),
		).rejects.toThrow();
		const sourceColumnsAfterDown = await listColumnNames(ctx, "_emdash_media_usage_sources");
		expect(sourceColumnsAfterDown.has("source_completeness")).toBe(false);

		await migration.up(ctx.db);

		const statusColumns = await listColumnNames(ctx, "_emdash_media_usage_index_status");
		expect(statusColumns.has("adapter_id")).toBe(true);
		const sourceColumnsAfterUp = await listColumnNames(ctx, "_emdash_media_usage_sources");
		expect(sourceColumnsAfterUp.has("source_completeness")).toBe(true);
	});
});

async function listColumnNames(
	ctx: DialectTestContext,
	tableName: keyof Database,
): Promise<Set<string>> {
	const tables = await ctx.db.introspection.getTables();
	const table = tables.find((candidate) => candidate.name === tableName);
	return new Set(table?.columns.map((column) => column.name) ?? []);
}

async function listIndexNames(ctx: DialectTestContext): Promise<Set<string>> {
	if (ctx.dialect === "sqlite") {
		const result = await sql<{ name: string }>`
			SELECT name FROM sqlite_master WHERE type = 'index'
		`.execute(ctx.db);
		return new Set(result.rows.map((row) => row.name));
	}

	const result = await sql<{ name: string }>`
		SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema()
	`.execute(ctx.db);
	return new Set(result.rows.map((row) => row.name));
}
