import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import type { Database as DatabaseSchema } from "../../../src/database/types.js";

interface CapturedQuery {
	sql: string;
	parameters: readonly unknown[];
}

let sqlite: Database.Database;
let db: Kysely<DatabaseSchema>;
let repo: MediaUsageRepository;
let captured: CapturedQuery[];

beforeEach(async () => {
	captured = [];
	sqlite = new Database(":memory:");
	db = new Kysely<DatabaseSchema>({
		dialect: new SqliteDialect({ database: sqlite }),
		log(event) {
			if (event.level === "query") {
				captured.push({ sql: event.query.sql, parameters: event.query.parameters });
			}
		},
	});
	await runMigrations(db);
	repo = new MediaUsageRepository(db);
});

afterEach(async () => {
	await db.destroy();
});

it("keeps aggregate progress to one indexed metadata statement as collections grow", async () => {
	for (let offset = 0; offset < 1_000; offset += 50) {
		const collections = Array.from({ length: 50 }, (_, index) => {
			const suffix = String(offset + index).padStart(4, "0");
			return {
				id: `collection-${suffix}`,
				slug: `collection_${suffix}`,
				label: `Collection ${suffix}`,
				has_seo: 0,
			};
		});
		await db.insertInto("_emdash_collections").values(collections).execute();
		await db
			.insertInto("_emdash_media_usage_index_status")
			.values(
				collections.map((collection) => ({
					adapter_id: "content-media",
					scope_type: "collection",
					scope_key: collection.slug,
					status: "complete",
					schema_version: 1,
					collection_id: collection.id,
					reconciliation_required: 0,
					capture_state: "active",
				})),
			)
			.execute();
	}
	await db
		.updateTable("_emdash_media_usage_activation")
		.set({ state: "active" })
		.where("task_key", "=", "incremental_capture")
		.execute();
	captured = [];

	await expect(repo.findCollectionProgress()).resolves.toEqual({
		status: "ready",
		readyCollections: 1_000,
		totalCollections: 1_000,
	});

	expect(captured).toHaveLength(1);
	const query = captured[0]!;
	expect(query.parameters.length).toBeLessThan(10);
	expect(query.sql).not.toContain("ec_");
	expect(query.sql).not.toContain("_emdash_media_usage_sources");
	expect(query.sql).not.toMatch(/FROM ["`]?_emdash_media_usage["`]?\s/i);
	const plan = sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
		.all(...query.parameters)
		.map((row) => (row as { detail: string }).detail)
		.join("\n");
	expect(plan).toContain("idx__emdash_media_usage_status_collection");
	expect(plan).toContain("idx__emdash_media_usage_work_operator");
	expect(plan).toMatch(/SEARCH reconciliation USING INDEX .*reconciliations/);
	expect(plan).not.toContain("USE TEMP B-TREE");
});
