/**
 * Query-plan and statement-count coverage for media usage reads.
 *
 * SQLite runs without ANALYZE/sqlite_stat1 here, matching D1's stats-blind
 * planner. Dialect result parity is covered by media-usage-read-repository.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import type { Database as DatabaseSchema } from "../../../src/database/types.js";
import { buildContentMediaUsageSourceKey } from "../../../src/media/usage/source-key.js";
import { SQL_BATCH_SIZE } from "../../../src/utils/chunks.js";

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
	await db
		.insertInto("_emdash_collections")
		.values({ id: "collection-posts", slug: "posts", label: "Posts", has_seo: 0 })
		.execute();
	repo = new MediaUsageRepository(db);
	await repo.replaceSource(
		{
			sourceKey: buildContentMediaUsageSourceKey({
				collectionSlug: "posts",
				contentId: "entry-1",
				sourceVariant: "columns",
			}),
			sourceType: "content",
			collectionSlug: "posts",
			contentId: "entry-1",
			sourceVariant: "columns",
			locale: "en",
			contentStatus: "published",
		},
		[
			{
				fieldSlug: "hero",
				fieldPath: "hero",
				referenceType: "image_field",
				mediaId: "media-shared",
				provider: "local",
				providerAssetId: "media-shared",
			},
		],
	);
	captured = [];
});

afterEach(async () => {
	await db.destroy();
});

it("seeks batched counts through the media/source/generation index", async () => {
	const mediaIds = [
		"media-shared",
		...Array.from({ length: SQL_BATCH_SIZE }, (_, index) => `media-${index}`),
	];

	await repo.findActiveEntryCountsByMediaIds(mediaIds);

	const queries = captured.filter((query) => query.sql.includes("visible_entries"));
	expect(queries).toHaveLength(2);
	for (const query of queries) {
		const plan = explain(query);
		expect(query.parameters.length).toBeLessThanOrEqual(100);
		expect(firstSourceOrUsageAccess(plan)).toMatch(
			/SEARCH u USING (?:COVERING )?INDEX idx__emdash_media_usage_media_source_generation/,
		);
		expect(plan).toContain("idx__emdash_media_usage_media_source_generation");
		expect(plan).toContain("idx__emdash_media_usage_sources_content");
		expect(plan).not.toContain("SCAN u");
	}
});

it("loads coverage and one grouped page in one statement each", async () => {
	await repo.findCollectionIndexStatusScopes({
		adapterId: "content-media",
		scopeType: "collection",
	});
	await repo.findCurrentEntryUsagePageByMediaId("media-shared", { limit: 1 });

	const coverageQueries = captured.filter(
		(query) =>
			query.sql.includes("_emdash_media_usage_index_status") && query.sql.includes("left join"),
	);
	const groupedQueries = captured.filter((query) => query.sql.includes("matched_groups"));
	expect(coverageQueries).toHaveLength(1);
	expect(groupedQueries).toHaveLength(1);
	expect(groupedQueries[0]!.sql).toContain("entry_state");
	expect(groupedQueries[0]!.sql).not.toContain("deleted_source");

	const plan = explain(groupedQueries[0]!);
	expect(firstSourceOrUsageAccess(plan)).toMatch(
		/SEARCH u USING (?:COVERING )?INDEX idx__emdash_media_usage_media_source_generation/,
	);
	expectPageBoundedHydration(plan);
	expect(plan).toContain("idx__emdash_media_usage_media_source_generation");
	expect(plan).toContain("idx__emdash_media_usage_sources_content");
	expect(plan).not.toContain("SCAN u");
});

it("keeps a high-cardinality grouped read to one indexed statement", async () => {
	for (let index = 2; index <= 200; index++) {
		const contentId = `entry-${String(index).padStart(3, "0")}`;
		await repo.replaceSource(
			{
				sourceKey: buildContentMediaUsageSourceKey({
					collectionSlug: "posts",
					contentId,
					sourceVariant: "columns",
				}),
				sourceType: "content",
				collectionSlug: "posts",
				contentId,
				sourceVariant: "columns",
				locale: "en",
				contentStatus: "published",
			},
			[
				{
					fieldSlug: "hero",
					fieldPath: "hero",
					referenceType: "image_field",
					mediaId: "media-shared",
					provider: "local",
					providerAssetId: "media-shared",
				},
			],
		);
	}
	captured = [];

	const page = await repo.findCurrentEntryUsagePageByMediaId("media-shared", { limit: 2 });

	expect(page.items.map((item) => item.contentId)).toEqual(["entry-002", "entry-003"]);
	expect(page.nextCursor).toEqual(expect.any(String));
	const queries = captured.filter((query) => query.sql.includes("matched_groups"));
	expect(queries).toHaveLength(1);
	const plan = explain(queries[0]!);
	expect(firstSourceOrUsageAccess(plan)).toMatch(
		/SEARCH u USING (?:COVERING )?INDEX idx__emdash_media_usage_media_source_generation/,
	);
	expectPageBoundedHydration(plan);
	expect(plan).toContain("idx__emdash_media_usage_media_source_generation");
	expect(plan).toContain("idx__emdash_media_usage_sources_content");
	expect(plan).not.toContain("SCAN u");
});

/** better-sqlite3 only binds primitives; coerce values captured from Kysely. */
function bindable(parameter: unknown): unknown {
	if (typeof parameter === "boolean") return parameter ? 1 : 0;
	if (parameter instanceof Date) return parameter.toISOString();
	if (parameter === undefined) return null;
	return parameter;
}

function explain(query: CapturedQuery): string {
	const rows = sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
		.all(...query.parameters.map(bindable)) as { detail: string }[];
	return rows.map((row) => row.detail).join("\n");
}

function firstSourceOrUsageAccess(plan: string): string | undefined {
	return plan.split("\n").find((detail) => /\b(?:SCAN|SEARCH) (?:s|u)\b/.test(detail));
}

function expectPageBoundedHydration(plan: string): void {
	const mediaAccesses = plan
		.split("\n")
		.filter(
			(detail) =>
				detail.includes("SEARCH u USING") &&
				detail.includes("idx__emdash_media_usage_media_source_generation"),
		);
	expect(mediaAccesses).toHaveLength(2);
	expect(mediaAccesses[0]).toMatch(/\(media_id=\?\)$/);
	expect(mediaAccesses[1]).toMatch(/\(media_id=\? AND source_key=\? AND generation=\?\)$/);
}
