import Database from "better-sqlite3";
import {
	CompiledQuery,
	Kysely,
	SqliteDialect,
	sql,
	type KyselyPlugin,
	type PluginTransformQueryArgs,
	type PluginTransformResultArgs,
	type QueryResult,
	type RootOperationNode,
	type UnknownRow,
} from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import type { Database as DatabaseSchema } from "../../../src/database/types.js";
import {
	cleanupMediaUsage,
	MEDIA_USAGE_CLEANUP_CANDIDATE_LIMIT,
	MEDIA_USAGE_CLEANUP_DELETE_LIMIT,
} from "../../../src/media/usage/cleanup.js";
import { hasPgTestDatabase, setupForDialect, teardownForDialect } from "../../utils/test-db.js";

interface CapturedQuery {
	sql: string;
	parameters: readonly unknown[];
}

const MAX_CLEANUP_STATEMENTS_PER_TICK = 16;
const MAX_BIND_PARAMETERS_PER_CLEANUP_STATEMENT = 52;
const MAX_CLEANUP_ADMISSION_TIME_MS = 5_000;

let sqlite: Database.Database;
let db: Kysely<DatabaseSchema>;
let repo: MediaUsageRepository;
let captured: CapturedQuery[];
let afterQuery: ((query: CapturedQuery) => void) | undefined;

beforeEach(async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date());
	captured = [];
	afterQuery = undefined;
	sqlite = new Database(":memory:");
	db = new Kysely<DatabaseSchema>({
		dialect: new SqliteDialect({ database: sqlite }),
		log(event) {
			if (event.level === "query") {
				const query = { sql: event.query.sql, parameters: event.query.parameters };
				captured.push(query);
				afterQuery?.(query);
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
	expect(captured.length).toBeLessThanOrEqual(MAX_CLEANUP_STATEMENTS_PER_TICK);
	for (const query of captured) {
		expect(query.parameters.length).toBeLessThanOrEqual(MAX_BIND_PARAMETERS_PER_CLEANUP_STATEMENT);
	}

	const candidateQuery = captured.find(
		(query) =>
			query.sql.toLowerCase().includes("left join") &&
			query.sql.includes("_emdash_media_usage_generation_writes"),
	);
	expect(candidateQuery).toBeDefined();
	const plan = explain(candidateQuery!);
	expect(plan).toContain("idx__emdash_media_usage_cleanup_scan");
	expect(plan).not.toContain("USE TEMP B-TREE");
});

it("uses the expiry index without sorting generation write leases", async () => {
	await db
		.insertInto("_emdash_media_usage_generation_writes")
		.values(
			Array.from({ length: 20 }, (_, index) => ({
				source_key: `expired-source-${index}`,
				generation: `expired-generation-${index}`,
				lease_token: `expired-writer-lease-${index}`,
				expires_at: "2026-02-01T00:00:00.000Z",
				created_at: "2026-02-01T00:00:00.000Z",
			})),
		)
		.execute();
	captured = [];
	afterQuery = (query) => {
		if (query.sql.startsWith('select "lease_token" from "_emdash_media_usage_generation_writes"')) {
			vi.advanceTimersByTime(MAX_CLEANUP_ADMISSION_TIME_MS);
		}
	};

	await cleanupMediaUsage(db);

	const expiryQuery = captured.find((query) =>
		query.sql.startsWith('select "lease_token" from "_emdash_media_usage_generation_writes"'),
	);
	expect(expiryQuery).toBeDefined();
	const plan = explain(expiryQuery!);
	expect(plan).toContain("idx__emdash_media_usage_generation_writes_expiry");
	expect(plan).not.toContain("USE TEMP B-TREE");
});

it("does not dispatch a delete after marking consumes the time budget", async () => {
	const stale = await repo.replaceSource(contentSource("entry-deadline"), [
		occurrence("media-before-deadline"),
	]);
	await repo.replaceSource(contentSource("entry-deadline"), [occurrence("media-current")]);
	await db
		.updateTable("_emdash_media_usage")
		.set({ created_at: "2026-02-01T19:00:00.000Z" })
		.where("generation", "=", stale.currentGeneration)
		.execute();
	captured = [];
	let marked = false;
	afterQuery = (query) => {
		if (query.sql.startsWith('update "_emdash_media_usage" set "cleanup_lease_token"')) {
			marked = true;
			vi.advanceTimersByTime(MAX_CLEANUP_ADMISSION_TIME_MS);
		}
	};

	const result = await cleanupMediaUsage(db);

	expect(marked).toBe(true);
	expect(result).toEqual(
		expect.objectContaining({
			candidateRows: 1,
			deletedRows: 0,
			durationMs: MAX_CLEANUP_ADMISSION_TIME_MS,
		}),
	);
	expect(captured.some((query) => query.sql.startsWith('delete from "_emdash_media_usage"'))).toBe(
		false,
	);
	expect(
		await db
			.selectFrom("_emdash_media_usage")
			.select("id")
			.where("generation", "=", stale.currentGeneration)
			.execute(),
	).toHaveLength(1);
});

it.each([
	{
		name: "full page after prior progress",
		currentRows: MEDIA_USAGE_CLEANUP_CANDIDATE_LIMIT - MEDIA_USAGE_CLEANUP_DELETE_LIMIT,
		hasPriorCursor: true,
	},
	{ name: "short page after prior progress", currentRows: 0, hasPriorCursor: true },
	{ name: "short first page", currentRows: 0, hasPriorCursor: false },
])("preserves finite sweep state for a partial $name", async ({ currentRows, hasPriorCursor }) => {
	const stale = await repo.replaceSource(
		contentSource("entry-partial-deadline"),
		Array.from({ length: MEDIA_USAGE_CLEANUP_DELETE_LIMIT }, (_, index) =>
			occurrence(`media-stale-${index}`, `stale-${index}`),
		),
	);
	const current = await repo.replaceSource(contentSource("entry-partial-deadline"), [
		...(hasPriorCursor ? [occurrence("media-before-stale", "before-stale")] : []),
		...Array.from({ length: currentRows }, (_, index) =>
			occurrence(`media-current-${index}`, `current-${index}`),
		),
	]);
	await db
		.updateTable("_emdash_media_usage")
		.set({ created_at: "2026-02-01T18:00:00.000Z" })
		.where("generation", "=", stale.currentGeneration)
		.execute();
	await db
		.updateTable("_emdash_media_usage")
		.set({ created_at: "2026-02-01T19:00:00.000Z" })
		.where("generation", "!=", stale.currentGeneration)
		.execute();
	await db
		.updateTable("_emdash_media_usage")
		.set({ created_at: "2026-02-01T17:00:00.000Z" })
		.where("generation", "=", current.currentGeneration)
		.where("field_path", "=", "before-stale")
		.execute();
	const priorCursor = hasPriorCursor
		? await db
				.selectFrom("_emdash_media_usage")
				.select(["id", "created_at"])
				.where("generation", "=", current.currentGeneration)
				.where("field_path", "=", "before-stale")
				.executeTakeFirstOrThrow()
		: null;
	const scanBeforeAt = "2026-02-02T00:00:00.000Z";
	await db
		.updateTable("_emdash_media_usage_cleanup")
		.set({
			cursor_created_at: priorCursor?.created_at ?? null,
			cursor_id: priorCursor?.id ?? null,
			scan_before_at: scanBeforeAt,
		})
		.where("task_key", "=", "projection_gc")
		.execute();
	captured = [];
	let firstDeleteCompleted = false;
	afterQuery = (query) => {
		if (!firstDeleteCompleted && query.sql.startsWith('delete from "_emdash_media_usage"')) {
			firstDeleteCompleted = true;
			vi.advanceTimersByTime(MAX_CLEANUP_ADMISSION_TIME_MS);
		}
	};

	const result = await cleanupMediaUsage(db);

	expect(firstDeleteCompleted).toBe(true);
	expect(result.candidateRows).toBe(MEDIA_USAGE_CLEANUP_DELETE_LIMIT + currentRows);
	expect(result.deletedRows).toBeGreaterThan(0);
	expect(result.deletedRows).toBeLessThan(MEDIA_USAGE_CLEANUP_DELETE_LIMIT);
	afterQuery = undefined;
	expect(
		captured.filter((query) =>
			query.sql.startsWith('update "_emdash_media_usage" set "cleanup_lease_token"'),
		),
	).toHaveLength(1);
	expect(
		await db
			.selectFrom("_emdash_media_usage_cleanup")
			.select(["cursor_created_at", "cursor_id", "scan_before_at"])
			.where("task_key", "=", "projection_gc")
			.executeTakeFirstOrThrow(),
	).toEqual({
		cursor_created_at: priorCursor?.created_at ?? null,
		cursor_id: priorCursor?.id ?? null,
		scan_before_at: scanBeforeAt,
	});
	const remaining = await db
		.selectFrom("_emdash_media_usage")
		.select("cleanup_lease_token")
		.where("generation", "=", stale.currentGeneration)
		.execute();
	expect(remaining).toHaveLength(MEDIA_USAGE_CLEANUP_DELETE_LIMIT - result.deletedRows);
	expect(remaining.every((row) => row.cleanup_lease_token === null)).toBe(true);
});

it("retains the sweep after reaching the delete cap on a short page", async () => {
	const stale = await repo.replaceSource(
		contentSource("entry-short-delete-cap"),
		Array.from({ length: MEDIA_USAGE_CLEANUP_DELETE_LIMIT + 1 }, (_, index) =>
			occurrence(`media-stale-cap-${index}`, `stale-cap-${index}`),
		),
	);
	const current = await repo.replaceSource(contentSource("entry-short-delete-cap"), [
		occurrence("media-before-stale-cap", "before-stale-cap"),
	]);
	await db
		.updateTable("_emdash_media_usage")
		.set({ created_at: "2026-02-01T18:00:00.000Z" })
		.where("generation", "=", stale.currentGeneration)
		.execute();
	await db
		.updateTable("_emdash_media_usage")
		.set({ created_at: "2026-02-01T17:00:00.000Z" })
		.where("generation", "=", current.currentGeneration)
		.execute();
	const priorCursor = await db
		.selectFrom("_emdash_media_usage")
		.select(["id", "created_at"])
		.where("generation", "=", current.currentGeneration)
		.executeTakeFirstOrThrow();
	const staleCandidates = await db
		.selectFrom("_emdash_media_usage")
		.select(["id", "created_at"])
		.where("generation", "=", stale.currentGeneration)
		.orderBy("created_at", "asc")
		.orderBy("id", "asc")
		.execute();
	const expectedCursor = staleCandidates[MEDIA_USAGE_CLEANUP_DELETE_LIMIT - 1]!;
	const expectedRemaining = staleCandidates[MEDIA_USAGE_CLEANUP_DELETE_LIMIT]!;
	const scanBeforeAt = "2026-02-02T00:00:00.000Z";
	await db
		.updateTable("_emdash_media_usage_cleanup")
		.set({
			cursor_created_at: priorCursor.created_at,
			cursor_id: priorCursor.id,
			scan_before_at: scanBeforeAt,
		})
		.where("task_key", "=", "projection_gc")
		.execute();

	const result = await cleanupMediaUsage(db);

	expect(result).toEqual(
		expect.objectContaining({
			candidateRows: MEDIA_USAGE_CLEANUP_DELETE_LIMIT + 1,
			deletedRows: MEDIA_USAGE_CLEANUP_DELETE_LIMIT,
			scanHasMore: false,
		}),
	);
	expect(
		await db
			.selectFrom("_emdash_media_usage_cleanup")
			.select(["cursor_created_at", "cursor_id", "scan_before_at"])
			.where("task_key", "=", "projection_gc")
			.executeTakeFirstOrThrow(),
	).toEqual({
		cursor_created_at: expectedCursor.created_at,
		cursor_id: expectedCursor.id,
		scan_before_at: scanBeforeAt,
	});
	expect(
		await db
			.selectFrom("_emdash_media_usage")
			.select("id")
			.where("generation", "=", stale.currentGeneration)
			.execute(),
	).toEqual([{ id: expectedRemaining.id }]);
});

it("does not delete writer leases after their scan consumes the time budget", async () => {
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
	let scanned = false;
	afterQuery = (query) => {
		if (query.sql.startsWith('select "lease_token" from "_emdash_media_usage_generation_writes"')) {
			scanned = true;
			vi.advanceTimersByTime(MAX_CLEANUP_ADMISSION_TIME_MS);
		}
	};

	const result = await cleanupMediaUsage(db);

	expect(scanned).toBe(true);
	expect(result).toEqual(
		expect.objectContaining({
			deletedWriteLeases: 0,
			durationMs: MAX_CLEANUP_ADMISSION_TIME_MS,
		}),
	);
	expect(
		captured.some((query) =>
			query.sql.startsWith('delete from "_emdash_media_usage_generation_writes"'),
		),
	).toBe(false);
	afterQuery = undefined;
	expect(
		await db
			.selectFrom("_emdash_media_usage_generation_writes")
			.select("lease_token")
			.where("lease_token", "=", "expired-writer-lease")
			.execute(),
	).toHaveLength(1);
	expect(
		await db
			.selectFrom("_emdash_media_usage_cleanup")
			.select(["cursor_created_at", "cursor_id", "scan_before_at"])
			.where("task_key", "=", "projection_gc")
			.executeTakeFirstOrThrow(),
	).toEqual({
		cursor_created_at: null,
		cursor_id: null,
		scan_before_at: expect.any(String),
	});
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

	const result = await cleanupMediaUsage(db);
	expect(result).toEqual(
		expect.objectContaining({
			status: "failed",
			candidateRows: MEDIA_USAGE_CLEANUP_DELETE_LIMIT,
			deletedRows: MEDIA_USAGE_CLEANUP_DELETE_LIMIT,
			deletedOrphans: MEDIA_USAGE_CLEANUP_DELETE_LIMIT - 2,
			deletedStale: 1,
			deletedAbandoned: 1,
			deletedWriteLeases: 1,
		}),
	);
	expect(captured.some((query) => query.parameters.includes("MEDIA_USAGE_CLEANUP_FAILED"))).toBe(
		true,
	);
	expect(captured.length).toBeLessThanOrEqual(MAX_CLEANUP_STATEMENTS_PER_TICK);
	for (const query of captured) {
		expect(query.parameters.length).toBeLessThanOrEqual(MAX_BIND_PARAMETERS_PER_CLEANUP_STATEMENT);
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

/** Compiles every statement a repository call issues, so a plan test can EXPLAIN the real query. */
class CompiledQueryRecorder implements KyselyPlugin {
	readonly queries: CompiledQuery[] = [];

	constructor(private readonly target: Kysely<DatabaseSchema>) {}

	transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
		this.queries.push(this.target.getExecutor().compileQuery(args.node, args.queryId));
		return args.node;
	}

	async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
		return args.result;
	}
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
		for (let batchStart = 0; batchStart < 6_000; batchStart += 1_000) {
			await context.db
				.insertInto("_emdash_media_usage")
				.values(
					Array.from({ length: 1_000 }, (_, offset) => {
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
		const recorder = new CompiledQueryRecorder(context.db);
		await new MediaUsageRepository(context.db.withPlugin(recorder)).findMediaUsageCleanupCandidates(
			{
				cutoff: now.toISOString(),
				cursor: null,
				limit: MEDIA_USAGE_CLEANUP_CANDIDATE_LIMIT,
			},
		);
		const scan = recorder.queries.at(-1);
		if (!scan) throw new Error("the candidate scan issued no statement");
		const result = await context.db.executeQuery<{ "QUERY PLAN": string }>(
			CompiledQuery.raw(`EXPLAIN (COSTS OFF) ${scan.sql}`, [...scan.parameters]),
		);
		const plan = result.rows.map((row) => row["QUERY PLAN"]).join("\n");

		expect(plan).toMatch(/Index(?: Only)? Scan using idx__emdash_media_usage_cleanup_scan/);
		expect(plan).not.toContain("Sort");
	} finally {
		await teardownForDialect(context);
	}
});
