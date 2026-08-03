import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import type { Database as DatabaseSchema } from "../../../src/database/types.js";
import {
	cleanupMediaUsage,
	MEDIA_USAGE_CLEANUP_DELETE_LIMIT,
} from "../../../src/media/usage/cleanup.js";
import { hasPgTestDatabase, setupForDialect, teardownForDialect } from "../../utils/test-db.js";

interface CapturedQuery {
	sql: string;
	parameters: readonly unknown[];
}

let sqlite: Database.Database;
let db: Kysely<DatabaseSchema>;
let repo: MediaUsageRepository;
let captured: CapturedQuery[];

beforeEach(async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date());
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
	vi.useRealTimers();
	await db.destroy();
});

it("uses an indexed, D1-compatible fixed statement and bind budget", async () => {
	const stale = await repo.replaceSource(
		contentSource("entry-budget"),
		Array.from({ length: MEDIA_USAGE_CLEANUP_DELETE_LIMIT }, (_, index) =>
			occurrence(`media-stale-${index}`, `field-${index}`),
		),
	);
	await repo.replaceSource(contentSource("entry-budget"), [occurrence("media-current")]);
	await db
		.updateTable("_emdash_media_usage")
		.set({ created_at: "2026-02-01T19:00:00.000Z" })
		.where("generation", "=", stale.currentGeneration)
		.execute();
	captured = [];

	const result = await cleanupMediaUsage(db);

	expect(result).toEqual(
		expect.objectContaining({
			status: "completed",
			candidateRows: MEDIA_USAGE_CLEANUP_DELETE_LIMIT,
			deletedRows: MEDIA_USAGE_CLEANUP_DELETE_LIMIT,
			backlogLowerBound: MEDIA_USAGE_CLEANUP_DELETE_LIMIT,
		}),
	);
	expect(captured.length).toBeLessThanOrEqual(14);
	for (const query of captured) {
		expect(query.parameters.length).toBeLessThanOrEqual(52);
	}

	const candidateQuery = captured.find(
		(query) =>
			query.sql.toLowerCase().includes("left join") &&
			query.sql.includes("_emdash_media_usage_generation_writes"),
	);
	expect(candidateQuery).toBeDefined();
	const plan = explain(candidateQuery!);
	expect(plan).toContain("idx__emdash_media_usage_cleanup_scan");
	expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
});

it("reserves a failure update within the fixed statement and bind budget", async () => {
	const stale = await repo.replaceSource(contentSource("entry-stale"), [occurrence("media-stale")]);
	await repo.replaceSource(contentSource("entry-stale"), [occurrence("media-current")]);
	await db
		.updateTable("_emdash_media_usage")
		.set({ created_at: "2026-02-01T19:00:00.000Z" })
		.where("generation", "=", stale.currentGeneration)
		.execute();
	for (let index = 0; index < MEDIA_USAGE_CLEANUP_DELETE_LIMIT - 2; index++) {
		await insertOccurrence(db, {
			id: `orphan-${index}`,
			sourceKey: `missing-source-${index}`,
			generation: `orphan-generation-${index}`,
			mediaId: `media-orphan-${index}`,
			createdAt: "2026-02-01T18:00:00.000Z",
		});
	}
	const abandoned = await repo.replaceSource(contentSource("entry-abandoned"), [
		occurrence("media-abandoned-current"),
	]);
	await db
		.updateTable("_emdash_media_usage_sources")
		.set({ indexed_at: "2026-02-01T18:00:00.000Z" })
		.where("source_key", "=", abandoned.sourceKey)
		.execute();
	await insertOccurrence(db, {
		id: "abandoned-occurrence",
		sourceKey: abandoned.sourceKey,
		generation: "abandoned-generation",
		mediaId: "media-abandoned",
		createdAt: "2026-02-01T19:00:00.000Z",
	});
	await db
		.insertInto("_emdash_media_usage_generation_writes")
		.values({
			source_key: "expired-source",
			generation: "expired-generation",
			lease_token: "expired-writer-lease",
			expires_at: "2026-02-01T00:00:00.000Z",
			created_at: "2026-02-01T00:00:00.000Z",
		})
		.execute();
	captured = [];
	const original = MediaUsageRepository.prototype.completeMediaUsageCleanup;
	vi.spyOn(MediaUsageRepository.prototype, "completeMediaUsageCleanup").mockImplementation(
		async function (this: MediaUsageRepository, input) {
			await original.call(this, input);
			throw new Error("completion transport failure");
		},
	);
	vi.spyOn(console, "error").mockImplementation(() => undefined);

	expect((await cleanupMediaUsage(db)).status).toBe("failed");
	expect(captured).toHaveLength(14);
	for (const query of captured) {
		expect(query.parameters.length).toBeLessThanOrEqual(52);
	}
});

function contentSource(contentId: string) {
	return {
		sourceKey: `content:posts:${contentId}:columns`,
		sourceType: "content",
		collectionSlug: "posts",
		contentId,
		sourceVariant: "columns" as const,
		contentStatus: "published",
	};
}

function occurrence(mediaId: string, fieldPath = "hero") {
	return {
		fieldSlug: fieldPath,
		fieldPath,
		referenceType: "image_field" as const,
		mediaId,
		provider: "local",
		providerAssetId: mediaId,
	};
}

async function insertOccurrence(
	database: Kysely<DatabaseSchema>,
	input: {
		id: string;
		sourceKey: string;
		generation: string;
		mediaId: string;
		createdAt: string;
	},
): Promise<void> {
	await database
		.insertInto("_emdash_media_usage")
		.values({
			id: input.id,
			source_key: input.sourceKey,
			generation: input.generation,
			field_slug: "hero",
			field_path: input.id,
			occurrence_index: 0,
			reference_type: "image_field",
			media_id: input.mediaId,
			provider: "local",
			provider_asset_id: input.mediaId,
			media_kind: "image",
			mime_type: null,
			created_at: input.createdAt,
		})
		.execute();
}

function explain(query: CapturedQuery): string {
	const rows = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.parameters) as {
		detail: string;
	}[];
	return rows.map((row) => row.detail).join("\n");
}

it.skipIf(!hasPgTestDatabase)("uses the cleanup scan index in PostgreSQL", async () => {
	const context = await setupForDialect("postgres");
	try {
		const now = new Date();
		for (let batchStart = 0; batchStart < 600; batchStart += 100) {
			await context.db
				.insertInto("_emdash_media_usage")
				.values(
					Array.from({ length: 100 }, (_, offset) => {
						const index = batchStart + offset;
						return {
							id: `plan-${index}`,
							source_key: `plan-source-${index}`,
							generation: `01K000000000000000000${String(index).padStart(3, "0")}`,
							field_slug: "hero",
							field_path: "hero",
							occurrence_index: 0,
							reference_type: "image_field",
							media_id: null,
							provider: "local",
							provider_asset_id: `plan-media-${index}`,
							media_kind: "image",
							mime_type: null,
							created_at: new Date(now.getTime() - (index + 2) * 60_000).toISOString(),
						};
					}),
				)
				.execute();
		}

		await sql`ANALYZE _emdash_media_usage`.execute(context.db);
		const result = await sql<{ "QUERY PLAN": string }>`
			EXPLAIN (COSTS OFF)
			SELECT u.id
			FROM _emdash_media_usage AS u
			LEFT JOIN _emdash_media_usage_sources AS s ON s.source_key = u.source_key
			LEFT JOIN _emdash_media_usage_generation_writes AS writer
				ON writer.source_key = u.source_key AND writer.generation = u.generation
			WHERE u.created_at < ${now.toISOString()}
			ORDER BY u.created_at ASC, u.id ASC
			LIMIT 250
		`.execute(context.db);
		const plan = result.rows.map((row) => row["QUERY PLAN"]).join("\n");

		expect(plan).toMatch(/Index(?: Only)? Scan using idx__emdash_media_usage_cleanup_scan/);
		expect(plan).not.toContain("Sort");
	} finally {
		await teardownForDialect(context);
	}
});
