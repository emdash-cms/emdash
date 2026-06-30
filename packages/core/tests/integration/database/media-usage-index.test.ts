import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("Media usage index schema", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("creates usage source and usage tables", async () => {
		for (const table of ["_emdash_media_usage_sources", "_emdash_media_usage"] as const) {
			const rows = await ctx.db
				.selectFrom(table as keyof Database)
				.selectAll()
				.execute();
			expect(Array.isArray(rows), `table ${table} should exist`).toBe(true);
		}
	});

	it("accepts a source row and a usage occurrence", async () => {
		await ctx.db
			.insertInto("_emdash_media_usage_sources")
			.values({
				source_key: "content:posts:entry1:live",
				source_type: "content",
				collection: "posts",
				content_id: "entry1",
				content_slug: "hello",
				locale: "en",
				translation_group: "entry1",
				content_status: "published",
				content_deleted_at: null,
				state: "live",
				revision_id: null,
				current_generation: "gen1",
			})
			.execute();

		await ctx.db
			.insertInto("_emdash_media_usage")
			.values({
				id: "usage1",
				source_key: "content:posts:entry1:live",
				generation: "gen1",
				media_id: "media1",
				provider: "local",
				provider_asset_id: "media1",
				media_kind: "image",
				mime_type: "image/jpeg",
				reference_type: "image_field",
				field_path: "hero",
				sort_order: 0,
			})
			.execute();

		const rows = await ctx.db
			.selectFrom("_emdash_media_usage")
			.selectAll()
			.where("media_id", "=", "media1")
			.execute();
		expect(rows).toHaveLength(1);
	});

	it("creates expected sqlite indexes", async () => {
		if (ctx.dialect !== "sqlite") return;

		const result = await sql<{ name: string }>`
			SELECT name FROM sqlite_master WHERE type = 'index'
		`.execute(ctx.db);
		const names = new Set(result.rows.map((row) => row.name));

		for (const indexName of [
			"idx__emdash_media_usage_sources_content",
			"idx__emdash_media_usage_sources_translation_group",
			"idx__emdash_media_usage_sources_state",
			"idx__emdash_media_usage_media",
			"idx__emdash_media_usage_provider_asset",
			"idx__emdash_media_usage_source_generation",
		]) {
			expect(names.has(indexName), `missing index ${indexName}`).toBe(true);
		}
	});

	it("down() drops tables and up() recreates them", async () => {
		const { down, up } = await import("../../../src/database/migrations/046_media_usage_index.js");

		await down(ctx.db);
		await expect(sql`SELECT 1 FROM _emdash_media_usage`.execute(ctx.db)).rejects.toThrow();
		await expect(sql`SELECT 1 FROM _emdash_media_usage_sources`.execute(ctx.db)).rejects.toThrow();

		await up(ctx.db);
		const rows = await ctx.db.selectFrom("_emdash_media_usage_sources").selectAll().execute();
		expect(Array.isArray(rows)).toBe(true);
	});
});
