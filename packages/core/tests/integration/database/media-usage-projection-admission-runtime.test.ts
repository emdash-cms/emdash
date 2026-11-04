import type {
	KyselyPlugin,
	PluginTransformQueryArgs,
	PluginTransformResultArgs,
	QueryResult,
	RootOperationNode,
	UnknownRow,
} from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import { refreshContentMediaUsage } from "../../../src/media/usage/content-refresh.js";
import { loadContentMediaUsageSnapshots } from "../../../src/media/usage/content-snapshots.js";
import { MEDIA_USAGE_MAINTENANCE_LIMITS } from "../../../src/media/usage/maintenance-engine.js";
import { buildContentMediaUsageSourceKey } from "../../../src/media/usage/source-key.js";
import { processMediaUsageWorkAfterWrite } from "../../../src/media/usage/work-processor.js";
import { createRequestMetrics, runWithContext } from "../../../src/request-context.js";
import {
	addMediaUsageMeasurementDraft,
	createMediaUsageAdmissionFixture,
	insertMediaUsageMeasurementEntry,
	mediaUsageMeasurementData,
} from "../../utils/media-usage-admission-fixture.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media usage projection admission runtime", (dialect) => {
	let ctx: DialectTestContext;
	let fixture: Awaited<ReturnType<typeof createMediaUsageAdmissionFixture>>;
	let repo: MediaUsageRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		fixture = await createMediaUsageAdmissionFixture(ctx.db, "admission_runtime");
		repo = new MediaUsageRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("terminally rejects an oversized replacement before publishing either variant", async () => {
		await insertEntry("oversized-variants", 250);
		await addMediaUsageMeasurementDraft(
			ctx.db,
			fixture,
			"oversized-variants",
			mediaUsageMeasurementData(251, "oversized-draft"),
		);

		const result = await processMediaUsageWorkAfterWrite(
			ctx.db,
			fixture.collectionSlug,
			"oversized-variants",
		);

		expect(result.outcome).toBe("failed");
		expect(await workRow("oversized-variants")).toEqual(
			expect.objectContaining({
				state: "failed",
				attempt_count: 1,
				last_error_code: "MEDIA_USAGE_RESOURCE_LIMIT",
			}),
		);
		expect((await repo.findSources(sourceKeys("oversized-variants"))).size).toBe(0);
		expect(await occurrenceCount("oversized-variants")).toBe(0);
		expect(await coverage()).toEqual(
			expect.objectContaining({
				status: "partial",
				last_error_code: "MEDIA_USAGE_RESOURCE_LIMIT",
			}),
		);
	});

	it("admits the occurrence boundary and keeps an oversized exact projection as a no-op", async () => {
		await insertEntry("boundary", 500);
		expect(
			(await processMediaUsageWorkAfterWrite(ctx.db, fixture.collectionSlug, "boundary")).outcome,
		).toBe("completed");
		expect(await currentOccurrenceCount("boundary", "columns")).toBe(500);

		await insertEntry("oversized-no-op", 501);
		const snapshots = await loadSnapshots("oversized-no-op");
		const snapshot = snapshots.find((candidate) => candidate.source.sourceVariant === "columns");
		if (!snapshot) throw new Error("Missing columns snapshot");
		const stored = await repo.replaceSource(snapshot.source, snapshot.occurrences);

		const result = await processMediaUsageWorkAfterWrite(
			ctx.db,
			fixture.collectionSlug,
			"oversized-no-op",
		);

		expect(result.outcome).toBe("completed");
		expect((await repo.findSource(snapshot.source.sourceKey))?.currentGeneration).toBe(
			stored.currentGeneration,
		);
		expect(await currentOccurrenceCount("oversized-no-op", "columns")).toBe(501);
	});

	it("rejects oversized source bytes without mutation", async () => {
		await insertMediaUsageMeasurementEntry(
			ctx.db,
			fixture,
			"oversized-bytes",
			mediaUsageMeasurementData(0, "oversized-bytes"),
			"é".repeat(1_050_000),
		);
		expect(
			(await processMediaUsageWorkAfterWrite(ctx.db, fixture.collectionSlug, "oversized-bytes"))
				.outcome,
		).toBe("failed");
		expect(await repo.findSource(sourceKey("oversized-bytes", "columns"))).toBeNull();
	});

	it("rejects oversized absent-source cleanup without mutation", async () => {
		await insertEntry("oversized-delete", 501);
		const snapshots = await loadSnapshots("oversized-delete");
		const snapshot = snapshots.find((candidate) => candidate.source.sourceVariant === "columns");
		if (!snapshot) throw new Error("Missing columns snapshot");
		const stored = await repo.replaceSource(snapshot.source, snapshot.occurrences);
		await sql`
			DELETE FROM ${sql.ref(fixture.tableName)}
			WHERE id = 'oversized-delete'
		`.execute(ctx.db);

		const deleted = await processMediaUsageWorkAfterWrite(
			ctx.db,
			fixture.collectionSlug,
			"oversized-delete",
		);

		expect(deleted.outcome).toBe("failed");
		expect((await repo.findSource(snapshot.source.sourceKey))?.currentGeneration).toBe(
			stored.currentGeneration,
		);
		expect(await currentOccurrenceCount("oversized-delete", "columns")).toBe(501);
	});

	it("leaves synchronous backwards-compatible refresh outside admission", async () => {
		await insertEntry("legacy-refresh", 13);

		const result = await refreshContentMediaUsage(ctx.db, fixture.collectionSlug, "legacy-refresh");

		expect(result.success).toBe(true);
		const count = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("source_key", "=", "content:admission_runtime:legacy-refresh:columns")
			.executeTakeFirstOrThrow();
		expect(Number(count.count)).toBe(13);
	});

	it("does not begin a bulk publication past the event query reservation", async () => {
		await insertEntry("query-bound-a", 1);
		await insertEntry("query-bound-b", 1);
		const projections = (
			await Promise.all([loadSnapshots("query-bound-a"), loadSnapshots("query-bound-b")])
		).flatMap((snapshots) =>
			snapshots.map((snapshot) => ({
				source: snapshot.source,
				occurrences: snapshot.occurrences,
			})),
		);
		const metrics = createRequestMetrics(performance.now());
		const initialDbCount =
			MEDIA_USAGE_MAINTENANCE_LIMITS.eventQueryCeiling -
			MEDIA_USAGE_MAINTENANCE_LIMITS.maxStepQueries -
			3;
		metrics.dbCount = initialDbCount;

		const inserted = await runWithContext({ editMode: false, metrics }, () =>
			repo.replaceNewSourcesBatch(projections),
		);

		expect(inserted).toEqual(new Set());
		expect(metrics.dbCount).toBe(initialDbCount);
		expect((await repo.findSources(sourceKeys("query-bound-a"))).size).toBe(0);
		expect((await repo.findSources(sourceKeys("query-bound-b"))).size).toBe(0);
	});

	it("defers immediately after a reserved conflict inside the shared step reservation", async () => {
		await insertEntry("conflict", 0);
		await addMediaUsageMeasurementDraft(
			ctx.db,
			fixture,
			"conflict",
			mediaUsageMeasurementData(12, "draft-initial"),
		);
		expect(
			(await processMediaUsageWorkAfterWrite(ctx.db, fixture.collectionSlug, "conflict")).outcome,
		).toBe("completed");
		await ctx.db
			.updateTable("revisions")
			.set({ data: JSON.stringify(mediaUsageMeasurementData(12, "draft-changed")) })
			.where("id", "=", "revision-conflict")
			.execute();
		await sql`
			UPDATE ${sql.ref(fixture.tableName)}
			SET updated_at = '2026-08-11T12:00:00.000Z'
			WHERE id = 'conflict'
		`.execute(ctx.db);
		await installDraftConflictTrigger(sourceKey("conflict", "draft_overlay"));
		const counter = new QueryCountingPlugin();
		const draftRowsBefore = await occurrenceCountForSource(sourceKey("conflict", "draft_overlay"));

		try {
			const result = await processMediaUsageWorkAfterWrite(
				ctx.db.withPlugin(counter),
				fixture.collectionSlug,
				"conflict",
			);
			expect(result.outcome).toBe("retry");
			expect(counter.count).toBeLessThanOrEqual(MEDIA_USAGE_MAINTENANCE_LIMITS.maxStepQueries);
			expect(
				(await occurrenceCountForSource(sourceKey("conflict", "draft_overlay"))) - draftRowsBefore,
			).toBe(12);
			expect(await workRow("conflict")).toEqual(
				expect.objectContaining({
					state: "retry",
					attempt_count: 1,
					last_error_code: "MEDIA_USAGE_GENERATION_CONFLICT",
				}),
			);
		} finally {
			await removeDraftConflictTrigger();
		}
	});

	async function insertEntry(contentId: string, occurrences: number): Promise<void> {
		await insertMediaUsageMeasurementEntry(
			ctx.db,
			fixture,
			contentId,
			mediaUsageMeasurementData(occurrences, contentId),
		);
	}

	async function loadSnapshots(contentId: string) {
		const result = await loadContentMediaUsageSnapshots(
			ctx.db,
			fixture.collectionSlug,
			contentId,
			undefined,
			{ collectionId: fixture.collectionId, identityVersion: 1 },
		);
		if (!result.success) throw new Error(result.error);
		return result.snapshots;
	}

	function sourceKey(contentId: string, sourceVariant: "columns" | "draft_overlay"): string {
		return buildContentMediaUsageSourceKey({
			collectionId: fixture.collectionId,
			collectionSlug: fixture.collectionSlug,
			contentId,
			sourceVariant,
		});
	}

	function sourceKeys(contentId: string): string[] {
		return [sourceKey(contentId, "columns"), sourceKey(contentId, "draft_overlay")];
	}

	async function occurrenceCount(contentId: string): Promise<number> {
		const row = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("source_key", "in", sourceKeys(contentId))
			.executeTakeFirstOrThrow();
		return Number(row.count);
	}

	async function occurrenceCountForSource(sourceKeyValue: string): Promise<number> {
		const row = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("source_key", "=", sourceKeyValue)
			.executeTakeFirstOrThrow();
		return Number(row.count);
	}

	async function currentOccurrenceCount(
		contentId: string,
		sourceVariant: "columns" | "draft_overlay",
	): Promise<number> {
		const source = await repo.findSource(sourceKey(contentId, sourceVariant));
		if (!source) return 0;
		const row = await ctx.db
			.selectFrom("_emdash_media_usage")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("source_key", "=", source.sourceKey)
			.where("generation", "=", source.currentGeneration)
			.executeTakeFirstOrThrow();
		return Number(row.count);
	}

	function workRow(contentId: string) {
		return ctx.db
			.selectFrom("_emdash_media_usage_work")
			.selectAll()
			.where("content_id", "=", contentId)
			.executeTakeFirstOrThrow();
	}

	function coverage() {
		return ctx.db
			.selectFrom("_emdash_media_usage_index_status")
			.selectAll()
			.where("collection_id", "=", fixture.collectionId)
			.executeTakeFirstOrThrow();
	}

	async function installDraftConflictTrigger(draftSourceKey: string): Promise<void> {
		if (ctx.dialect === "postgres") {
			await sql`
				CREATE FUNCTION media_usage_admission_draft_conflict()
				RETURNS trigger
				LANGUAGE plpgsql
				AS $$
				BEGIN
					IF NEW.source_key = ${sql.lit(draftSourceKey)} THEN
						UPDATE _emdash_media_usage_sources
						SET updated_at = updated_at || 'x'
						WHERE source_key = NEW.source_key;
					END IF;
					RETURN NEW;
				END;
				$$
			`.execute(ctx.db);
			await sql`
				CREATE TRIGGER media_usage_admission_draft_conflict
				AFTER INSERT ON _emdash_media_usage_generation_writes
				FOR EACH ROW EXECUTE FUNCTION media_usage_admission_draft_conflict()
			`.execute(ctx.db);
			return;
		}

		await sql`
			CREATE TRIGGER media_usage_admission_draft_conflict
			AFTER INSERT ON _emdash_media_usage_generation_writes
			WHEN NEW.source_key = ${sql.lit(draftSourceKey)}
			BEGIN
				UPDATE _emdash_media_usage_sources
				SET updated_at = updated_at || 'x'
				WHERE source_key = NEW.source_key;
			END
		`.execute(ctx.db);
	}

	async function removeDraftConflictTrigger(): Promise<void> {
		if (ctx.dialect === "postgres") {
			await sql`
				DROP TRIGGER media_usage_admission_draft_conflict
				ON _emdash_media_usage_generation_writes
			`.execute(ctx.db);
			await sql`DROP FUNCTION media_usage_admission_draft_conflict()`.execute(ctx.db);
			return;
		}
		await sql`DROP TRIGGER media_usage_admission_draft_conflict`.execute(ctx.db);
	}
});

class QueryCountingPlugin implements KyselyPlugin {
	count = 0;

	transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
		this.count++;
		return args.node;
	}

	transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
		return Promise.resolve(args.result);
	}
}
