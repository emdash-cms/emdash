import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const EXPECTED_INDEXES = [
	"idx__emdash_media_usage_sources_content",
	"idx__emdash_media_usage_sources_variant",
	"idx__emdash_media_usage_sources_locale",
	"idx__emdash_media_usage_sources_deleted",
	"idx__emdash_media_usage_sources_translation_group",
	"idx__emdash_media_usage_media_source_generation",
	"idx__emdash_media_usage_provider_asset",
	"idx__emdash_media_usage_source_generation",
	"idx__emdash_media_usage_unique_occurrence",
] as const;

describeEachDialect("media usage index migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("creates usage source and occurrence tables through registered migrations", async () => {
		const sources = await ctx.db
			.selectFrom("_emdash_media_usage_sources")
			.select("source_key")
			.execute();
		const usage = await ctx.db.selectFrom("_emdash_media_usage").select("id").execute();

		expect(Array.isArray(sources)).toBe(true);
		expect(Array.isArray(usage)).toBe(true);
	});

	it("accepts a content usage source and one occurrence", async () => {
		const sourceKey = "content:posts:entry1:columns";
		const generation = "gen1";

		await ctx.db
			.insertInto("_emdash_media_usage_sources")
			.values({
				source_key: sourceKey,
				source_type: "content",
				collection_slug: "posts",
				content_id: "entry1",
				source_variant: "columns",
				content_slug: "hello-world",
				content_title: "Hello World",
				locale: "en",
				translation_group: "tg1",
				content_status: "published",
				content_scheduled_at: null,
				content_deleted_at: null,
				revision_id: "rev1",
				current_generation: generation,
				schema_version: 1,
			})
			.execute();

		await ctx.db
			.insertInto("_emdash_media_usage")
			.values({
				id: "usage1",
				source_key: sourceKey,
				generation,
				field_slug: "hero",
				field_path: "hero",
				occurrence_index: 0,
				reference_type: "image_field",
				media_id: "media1",
				provider: "local",
				provider_asset_id: "media1",
				media_kind: "image",
				mime_type: "image/jpeg",
			})
			.execute();

		const rows = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select(["source_key", "media_id", "provider", "provider_asset_id", "field_path"])
			.where("media_id", "=", "media1")
			.execute();

		expect(rows).toEqual([
			{
				source_key: sourceKey,
				media_id: "media1",
				provider: "local",
				provider_asset_id: "media1",
				field_path: "hero",
			},
		]);
	});

	it("creates expected indexes", async () => {
		const indexNames = await listIndexNames(ctx);

		for (const indexName of EXPECTED_INDEXES) {
			expect(indexNames.has(indexName), `missing index ${indexName}`).toBe(true);
		}
	});

	it("replaces the media lookup index in retry-safe D1 statement order", async () => {
		const migration =
			await import("../../../src/database/migrations/052_media_usage_read_index.js");

		await migration.down(ctx.db);
		let indexNames = await listIndexNames(ctx);
		expect(indexNames.has("idx__emdash_media_usage_media_id")).toBe(true);
		expect(indexNames.has("idx__emdash_media_usage_media_source_generation")).toBe(false);

		// Simulate interruption after the first up statement, before the old index drops.
		await ctx.db.schema
			.createIndex("idx__emdash_media_usage_media_source_generation")
			.ifNotExists()
			.on("_emdash_media_usage")
			.columns(["media_id", "source_key", "generation"])
			.execute();
		await migration.up(ctx.db);
		await migration.up(ctx.db);

		indexNames = await listIndexNames(ctx);
		expect(indexNames.has("idx__emdash_media_usage_media_id")).toBe(false);
		expect(indexNames.has("idx__emdash_media_usage_media_source_generation")).toBe(true);

		// Simulate interruption after the first down statement, before the new index drops.
		await ctx.db.schema
			.createIndex("idx__emdash_media_usage_media_id")
			.ifNotExists()
			.on("_emdash_media_usage")
			.column("media_id")
			.execute();
		indexNames = await listIndexNames(ctx);
		expect(indexNames.has("idx__emdash_media_usage_media_id")).toBe(true);
		expect(indexNames.has("idx__emdash_media_usage_media_source_generation")).toBe(true);
		await migration.down(ctx.db);
		await migration.down(ctx.db);

		indexNames = await listIndexNames(ctx);
		expect(indexNames.has("idx__emdash_media_usage_media_id")).toBe(true);
		expect(indexNames.has("idx__emdash_media_usage_media_source_generation")).toBe(false);
	});

	it("down() drops tables and up() recreates them", async () => {
		const migration = await import("../../../src/database/migrations/046_media_usage_index.js");

		await migration.down(ctx.db);

		await expect(sql`SELECT 1 FROM _emdash_media_usage`.execute(ctx.db)).rejects.toThrow();
		await expect(sql`SELECT 1 FROM _emdash_media_usage_sources`.execute(ctx.db)).rejects.toThrow();

		await migration.up(ctx.db);

		const sources = await ctx.db
			.selectFrom("_emdash_media_usage_sources")
			.select("source_key")
			.execute();
		expect(Array.isArray(sources)).toBe(true);
	});
});

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
