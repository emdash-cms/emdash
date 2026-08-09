import type {
	Kysely,
	KyselyPlugin,
	PluginTransformQueryArgs,
	PluginTransformResultArgs,
	QueryResult,
	RootOperationNode,
	UnknownRow,
} from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaUsageWorkRepository } from "../../../src/database/repositories/media-usage-work.js";
import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import type { Database } from "../../../src/database/types.js";
import { installMediaUsageCaptureTriggers } from "../../../src/media/usage/capture-triggers.js";
import { loadContentMediaUsageSnapshots } from "../../../src/media/usage/content-snapshots.js";
import {
	MEDIA_USAGE_WORK_PROCESSING_LIMITS,
	processDueMediaUsageWork,
	processMediaUsageWorkAfterWrite,
} from "../../../src/media/usage/work-processor.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import type { CreateFieldInput } from "../../../src/schema/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media usage durable work processing", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("claims and completes the saved entry's durable job immediately", async () => {
		const fixture = await createActiveFixture(ctx, "posts");
		await insertEntry(ctx, fixture, "entry-1", "media-1");
		expect(await findCoverageStatus(ctx.db, fixture.collectionId)).toEqual(
			expect.objectContaining({ status: "stale", reconciliation_required: 0 }),
		);

		const result = await processMediaUsageWorkAfterWrite(ctx.db, "posts", "entry-1");

		expect(result.outcome).toBe("completed");
		expect(await countWork(ctx.db)).toBe(0);
		const source = await new MediaUsageRepository(ctx.db).findSource(
			canonicalSourceKey(fixture.collectionId, "entry-1"),
		);
		expect(source).toEqual(
			expect.objectContaining({
				collectionId: fixture.collectionId,
				collectionSlug: "posts",
				contentId: "entry-1",
				identityVersion: 1,
			}),
		);
		expect(await findCoverageStatus(ctx.db, fixture.collectionId)).toEqual(
			expect.objectContaining({
				status: "complete",
				reconciliation_required: 0,
				last_incremental_success_at: expect.any(String),
				last_error_code: null,
			}),
		);
	});

	it("does not create complete coverage from an untrusted incremental success", async () => {
		const fixture = await createActiveFixture(ctx, "untrusted");
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ status: "never", reconciliation_required: 1 })
			.where("collection_id", "=", fixture.collectionId)
			.execute();
		await insertEntry(ctx, fixture, "entry-1", "media-1");

		const result = await processMediaUsageWorkAfterWrite(ctx.db, "untrusted", "entry-1");

		expect(result.outcome).toBe("completed");
		expect(await countWork(ctx.db)).toBe(0);
		expect(await findCoverageStatus(ctx.db, fixture.collectionId)).toEqual(
			expect.objectContaining({
				status: "never",
				reconciliation_required: 1,
				last_incremental_success_at: expect.any(String),
			}),
		);
	});

	it("does not publish an obsolete terminal failure after newer work arrives", async () => {
		const fixture = await createActiveFixture(ctx, "failure_race");
		await insertEntry(ctx, fixture, "entry-1", "media-1");
		const failedVersion = await findWork(ctx.db);
		await ctx.db
			.updateTable("_emdash_media_usage_work")
			.set({ state: "failed", last_error_code: "OBSOLETE_FAILURE" })
			.where("collection_id", "=", fixture.collectionId)
			.where("content_id", "=", "entry-1")
			.where("work_version", "=", failedVersion.work_version)
			.execute();
		await sql`
			UPDATE ${sql.ref(fixture.tableName)}
			SET title = 'newer projection'
			WHERE id = 'entry-1'
		`.execute(ctx.db);

		const recorded = await new MediaUsageRepository(ctx.db).recordIncrementalFailure({
			collectionId: fixture.collectionId,
			collectionSlug: fixture.collectionSlug,
			contentId: "entry-1",
			workVersion: failedVersion.work_version,
			errorCode: "OBSOLETE_FAILURE",
		});

		expect(recorded).toBe(false);
		expect(await findWork(ctx.db)).toEqual(
			expect.objectContaining({
				state: "pending",
				work_version: expect.toSatisfy(
					(value) => Number(value) === Number(failedVersion.work_version) + 1,
				),
				last_error_code: null,
			}),
		);
		expect(await findCoverageStatus(ctx.db, fixture.collectionId)).toEqual(
			expect.objectContaining({ status: "stale" }),
		);
	});

	it("bounds each scheduled tick and leaves the backlog durable", async () => {
		const fixture = await createActiveFixture(ctx, "articles");
		for (let index = 0; index < 3; index++) {
			await insertEntry(ctx, fixture, `entry-${index}`, `media-${index}`);
		}

		const result = await processDueMediaUsageWork(ctx.db);

		expect(result.candidateCount).toBe(3);
		expect(result.claimedCount).toBe(MEDIA_USAGE_WORK_PROCESSING_LIMITS.jobsPerTick);
		expect(result.completedCount).toBe(MEDIA_USAGE_WORK_PROCESSING_LIMITS.jobsPerTick);
		expect(await countWork(ctx.db)).toBe(3 - MEDIA_USAGE_WORK_PROCESSING_LIMITS.jobsPerTick);
		expect(await findCoverageStatus(ctx.db, fixture.collectionId)).toEqual(
			expect.objectContaining({ status: "stale" }),
		);

		await processDueMediaUsageWork(ctx.db);
		await processDueMediaUsageWork(ctx.db);
		expect(await countWork(ctx.db)).toBe(0);
		expect(await findCoverageStatus(ctx.db, fixture.collectionId)).toEqual(
			expect.objectContaining({ status: "complete" }),
		);
	});

	it("lets only one overlapping fast path own the job", async () => {
		const fixture = await createActiveFixture(ctx, "notes");
		await insertEntry(ctx, fixture, "entry-1", "media-1");

		const outcomes = await Promise.all([
			processMediaUsageWorkAfterWrite(ctx.db, "notes", "entry-1"),
			processMediaUsageWorkAfterWrite(ctx.db, "notes", "entry-1"),
		]);

		expect(outcomes.filter((result) => result.outcome === "completed")).toHaveLength(1);
		expect(await countWork(ctx.db)).toBe(0);
		const source = await new MediaUsageRepository(ctx.db).findSource(
			canonicalSourceKey(fixture.collectionId, "entry-1"),
		);
		expect(source).not.toBeNull();
	});

	it("keeps newer work after projection and redelivers it as a no-op", async () => {
		const fixture = await createActiveFixture(ctx, "pages");
		await insertEntry(ctx, fixture, "entry-1", "media-1");
		await installProjectionSupersessionTrigger(ctx, "entry-1");

		const stale = await processMediaUsageWorkAfterWrite(ctx.db, "pages", "entry-1");
		expect(stale.outcome).toBe("superseded");
		const sourceBefore = await new MediaUsageRepository(ctx.db).findSource(
			canonicalSourceKey(fixture.collectionId, "entry-1"),
		);
		expect(sourceBefore).not.toBeNull();
		expect(await countWork(ctx.db)).toBe(1);

		await removeProjectionSupersessionTrigger(ctx);
		const redelivery = await processMediaUsageWorkAfterWrite(ctx.db, "pages", "entry-1");
		expect(redelivery.outcome).toBe("completed");
		expect(
			(
				await new MediaUsageRepository(ctx.db).findSource(
					canonicalSourceKey(fixture.collectionId, "entry-1"),
				)
			)?.currentGeneration,
		).toBe(sourceBefore?.currentGeneration);
		expect(await countWork(ctx.db)).toBe(0);
	});

	it("retries snapshot failures and retains the terminal failed row", async () => {
		const fixture = await createActiveFixture(ctx, "news");
		await insertEntry(ctx, fixture, "entry-1", "media-1");
		await sql`
			INSERT INTO revisions (id, collection, entry_id, data, author_id)
			VALUES ('broken-revision', 'news', 'entry-1', '{', NULL)
		`.execute(ctx.db);
		await sql`
			UPDATE ${sql.ref(fixture.tableName)}
			SET draft_revision_id = 'broken-revision'
			WHERE id = 'entry-1'
		`.execute(ctx.db);

		const retry = await processMediaUsageWorkAfterWrite(ctx.db, "news", "entry-1");
		expect(retry.outcome).toBe("retry");
		expect(await findWork(ctx.db)).toEqual(
			expect.objectContaining({
				state: "retry",
				attempt_count: 1,
				last_error_code: "MEDIA_USAGE_SNAPSHOT_FAILED",
			}),
		);
		expect(await findCoverageStatus(ctx.db, fixture.collectionId)).toEqual(
			expect.objectContaining({ status: "stale" }),
		);

		await ctx.db
			.updateTable("_emdash_media_usage_work")
			.set({
				state: "pending",
				attempt_count: MEDIA_USAGE_WORK_PROCESSING_LIMITS.maxAttempts - 1,
				next_attempt_at: "2000-01-01T00:00:00.000Z",
			})
			.execute();
		const failed = await processMediaUsageWorkAfterWrite(ctx.db, "news", "entry-1");
		expect(failed.outcome).toBe("failed");
		expect(await findWork(ctx.db)).toEqual(
			expect.objectContaining({
				state: "failed",
				attempt_count: MEDIA_USAGE_WORK_PROCESSING_LIMITS.maxAttempts,
				last_error_code: "MEDIA_USAGE_SNAPSHOT_FAILED",
			}),
		);
		expect(await findCoverageStatus(ctx.db, fixture.collectionId)).toEqual(
			expect.objectContaining({
				status: "partial",
				reconciliation_required: 0,
				last_error_code: "MEDIA_USAGE_SNAPSHOT_FAILED",
			}),
		);
	});

	it("publishes changed live and draft projections at the 14-occurrence boundary", async () => {
		const fixture = await createResourceFixture(ctx, "bounded_usage");
		await insertResourceEntry(ctx, fixture, "entry-1", mediaData(14, "live"));
		await addResourceDraft(ctx, fixture, "entry-1", mediaData(14, "draft"));

		const result = await processMediaUsageWorkAfterWrite(ctx.db, "bounded_usage", "entry-1");

		expect(result.outcome).toBe("completed");
		expect(await countWork(ctx.db)).toBe(0);
		expect(
			await countCurrentOccurrences(ctx.db, canonicalSourceKey(fixture.collectionId, "entry-1")),
		).toBe(14);
		expect(
			await countCurrentOccurrences(
				ctx.db,
				canonicalSourceKey(fixture.collectionId, "entry-1", "draft_overlay"),
			),
		).toBe(14);
	});

	it("fails changed oversized work terminally before publishing either projection", async () => {
		const fixture = await createResourceFixture(ctx, "oversized_usage");
		await insertResourceEntry(ctx, fixture, "entry-1", mediaData(1, "initial-live"));
		await addResourceDraft(ctx, fixture, "entry-1", mediaData(1, "initial-draft"));
		expect(
			(await processMediaUsageWorkAfterWrite(ctx.db, "oversized_usage", "entry-1")).outcome,
		).toBe("completed");

		const usageRepo = new MediaUsageRepository(ctx.db);
		const columnsKey = canonicalSourceKey(fixture.collectionId, "entry-1");
		const draftKey = canonicalSourceKey(fixture.collectionId, "entry-1", "draft_overlay");
		const columnsBefore = await usageRepo.findSource(columnsKey);
		const draftBefore = await usageRepo.findSource(draftKey);
		const storedColumnsBefore = await countStoredOccurrences(ctx.db, columnsKey);
		const storedDraftBefore = await countStoredOccurrences(ctx.db, draftKey);
		await updateResourceEntry(ctx, fixture, "entry-1", mediaData(14, "changed-live"));
		await updateResourceDraft(ctx, "entry-1", mediaData(15, "changed-draft"));

		const result = await processMediaUsageWorkAfterWrite(ctx.db, "oversized_usage", "entry-1");

		expect(result.outcome).toBe("failed");
		expect((await usageRepo.findSource(columnsKey))?.currentGeneration).toBe(
			columnsBefore?.currentGeneration,
		);
		expect((await usageRepo.findSource(draftKey))?.currentGeneration).toBe(
			draftBefore?.currentGeneration,
		);
		expect(await countCurrentOccurrences(ctx.db, columnsKey)).toBe(1);
		expect(await countCurrentOccurrences(ctx.db, draftKey)).toBe(1);
		expect(await countStoredOccurrences(ctx.db, columnsKey)).toBe(storedColumnsBefore);
		expect(await countStoredOccurrences(ctx.db, draftKey)).toBe(storedDraftBefore);
		expect(await findWork(ctx.db)).toEqual(
			expect.objectContaining({
				state: "failed",
				attempt_count: 1,
				last_error_code: "MEDIA_USAGE_RESOURCE_LIMIT",
			}),
		);
		expect(await findCoverageStatus(ctx.db, fixture.collectionId)).toEqual(
			expect.objectContaining({
				status: "partial",
				reconciliation_required: 0,
				last_error_code: "MEDIA_USAGE_RESOURCE_LIMIT",
			}),
		);

		const reopened = await new MediaUsageWorkRepository(ctx.db).retryOperatorWork({
			collectionId: fixture.collectionId,
			contentId: "entry-1",
		});
		expect(reopened).toEqual(expect.objectContaining({ outcome: "pending", changed: true }));
		expect(
			(await processMediaUsageWorkAfterWrite(ctx.db, "oversized_usage", "entry-1")).outcome,
		).toBe("failed");
		expect(await findWork(ctx.db)).toEqual(
			expect.objectContaining({
				state: "failed",
				attempt_count: 1,
				last_error_code: "MEDIA_USAGE_RESOURCE_LIMIT",
			}),
		);
		expect((await usageRepo.findSource(columnsKey))?.currentGeneration).toBe(
			columnsBefore?.currentGeneration,
		);
		expect((await usageRepo.findSource(draftKey))?.currentGeneration).toBe(
			draftBefore?.currentGeneration,
		);
	});

	it("completes an oversized projection only when the stored projection is an unchanged no-op", async () => {
		const fixture = await createResourceFixture(ctx, "oversized_noop");
		await insertResourceEntry(ctx, fixture, "entry-1", mediaData(15, "unchanged"));
		const snapshots = await loadContentMediaUsageSnapshots(
			ctx.db,
			fixture.collectionSlug,
			"entry-1",
			undefined,
			{ collectionId: fixture.collectionId, identityVersion: 1 },
		);
		if (!snapshots.success) throw new Error(`Expected snapshots, received ${snapshots.error}`);
		const usageRepo = new MediaUsageRepository(ctx.db);
		for (const snapshot of snapshots.snapshots) {
			await usageRepo.replaceSource(snapshot.source, snapshot.occurrences);
		}
		const sourceKey = canonicalSourceKey(fixture.collectionId, "entry-1");
		const before = await usageRepo.findSource(sourceKey);

		const result = await processMediaUsageWorkAfterWrite(ctx.db, "oversized_noop", "entry-1");

		expect(result.outcome).toBe("completed");
		expect(await countWork(ctx.db)).toBe(0);
		expect((await usageRepo.findSource(sourceKey))?.currentGeneration).toBe(
			before?.currentGeneration,
		);
		expect(await countCurrentOccurrences(ctx.db, sourceKey)).toBe(15);

		await ctx.db
			.updateTable("_emdash_media_usage_sources")
			.set({ last_error_code: "PROJECTION_INVALID" })
			.where("source_key", "=", sourceKey)
			.execute();
		await sql`
			UPDATE ${sql.ref(fixture.tableName)}
			SET title = title
			WHERE id = 'entry-1'
		`.execute(ctx.db);
		expect(
			(await processMediaUsageWorkAfterWrite(ctx.db, "oversized_noop", "entry-1")).outcome,
		).toBe("failed");
		expect(await findWork(ctx.db)).toEqual(
			expect.objectContaining({ last_error_code: "MEDIA_USAGE_RESOURCE_LIMIT" }),
		);
		expect((await usageRepo.findSource(sourceKey))?.currentGeneration).toBe(
			before?.currentGeneration,
		);
	});

	it("reconciles permanent entry absence without leaving work", async () => {
		const fixture = await createActiveFixture(ctx, "documents");
		await insertEntry(ctx, fixture, "entry-1", "media-1");
		await processMediaUsageWorkAfterWrite(ctx.db, "documents", "entry-1");
		const sourceKey = canonicalSourceKey(fixture.collectionId, "entry-1");
		expect(await new MediaUsageRepository(ctx.db).findSource(sourceKey)).not.toBeNull();

		await sql`DELETE FROM ${sql.ref(fixture.tableName)} WHERE id = 'entry-1'`.execute(ctx.db);
		const result = await processMediaUsageWorkAfterWrite(ctx.db, "documents", "entry-1");

		expect(result.outcome).toBe("completed");
		expect(await new MediaUsageRepository(ctx.db).findSource(sourceKey)).toBeNull();
		expect(await countWork(ctx.db)).toBe(0);
	});

	it("discards obsolete work without projecting into a replacement collection", async () => {
		const fixture = await createActiveFixture(ctx, "reused_slug");
		await insertEntry(ctx, fixture, "entry-1", "media-1");
		await ctx.db.deleteFrom("_emdash_collections").where("id", "=", fixture.collectionId).execute();
		await ctx.db
			.insertInto("_emdash_collections")
			.values({ id: "replacement-collection-id", slug: "reused_slug", label: "Replacement" })
			.execute();

		const result = await processDueMediaUsageWork(ctx.db);

		expect(result.obsoleteCount).toBe(1);
		expect(await countWork(ctx.db)).toBe(0);
		expect(
			await new MediaUsageRepository(ctx.db).findSource(
				canonicalSourceKey(fixture.collectionId, "entry-1"),
			),
		).toBeNull();
	});

	it("keeps an ordinary job inside the exported statement envelope", async () => {
		const fixture = await createActiveFixture(ctx, "measured");
		await insertEntry(ctx, fixture, "entry-1", "media-1");
		const counter = new QueryCountingPlugin();

		const result = await processMediaUsageWorkAfterWrite(
			ctx.db.withPlugin(counter),
			"measured",
			"entry-1",
		);

		expect(result.outcome).toBe("completed");
		expect(counter.count).toBeGreaterThan(0);
		expect(counter.count).toBeLessThanOrEqual(
			MEDIA_USAGE_WORK_PROCESSING_LIMITS.ordinaryStatementsPerJob,
		);
	});
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

async function createActiveFixture(
	ctx: DialectTestContext,
	collectionSlug: string,
	extraFields: readonly CreateFieldInput[] = [],
) {
	const registry = new SchemaRegistry(ctx.db);
	await registry.createCollection({ slug: collectionSlug, label: collectionSlug });
	await registry.createField(collectionSlug, { slug: "title", label: "Title", type: "string" });
	await registry.createField(collectionSlug, { slug: "hero", label: "Hero", type: "image" });
	for (const field of extraFields) await registry.createField(collectionSlug, field);
	const collection = await registry.getCollection(collectionSlug);
	if (!collection) throw new Error(`Expected ${collectionSlug} collection`);

	await ctx.db
		.updateTable("_emdash_media_usage_index_status")
		.set({
			collection_id: collection.id,
			status: "complete",
			completed_at: "2026-08-01T00:00:00.000Z",
			reconciliation_required: 0,
			capture_state: "installing",
		})
		.where("adapter_id", "=", "content-media")
		.where("scope_type", "=", "collection")
		.where("scope_key", "=", collectionSlug)
		.execute();
	await installMediaUsageCaptureTriggers(ctx.db, {
		collectionId: collection.id,
		collectionSlug,
	});
	await ctx.db
		.updateTable("_emdash_media_usage_index_status")
		.set({ capture_state: "active" })
		.where("collection_id", "=", collection.id)
		.execute();
	await ctx.db
		.updateTable("_emdash_media_usage_activation")
		.set({ state: "active", activated_at: "2026-08-05T00:00:00.000Z" })
		.execute();

	return {
		collectionId: collection.id,
		collectionSlug,
		tableName: `ec_${collectionSlug}`,
	};
}

async function createResourceFixture(ctx: DialectTestContext, collectionSlug: string) {
	return createActiveFixture(ctx, collectionSlug, [
		{ slug: "body", label: "Body", type: "portableText" },
		{
			slug: "sections",
			label: "Sections",
			type: "repeater",
			validation: { subFields: [{ slug: "image", type: "image", label: "Image" }] },
		},
	]);
}

async function insertEntry(
	ctx: DialectTestContext,
	fixture: Awaited<ReturnType<typeof createActiveFixture>>,
	contentId: string,
	mediaId: string,
): Promise<void> {
	await sql`
		INSERT INTO ${sql.ref(fixture.tableName)} (id, slug, status, title, hero)
		VALUES (
			${contentId},
			${contentId},
			'published',
			${contentId},
			${JSON.stringify({ id: mediaId, provider: "local", mimeType: "image/webp" })}
		)
	`.execute(ctx.db);
}

async function insertResourceEntry(
	ctx: DialectTestContext,
	fixture: Awaited<ReturnType<typeof createResourceFixture>>,
	contentId: string,
	data: ReturnType<typeof mediaData>,
): Promise<void> {
	await sql`
		INSERT INTO ${sql.ref(fixture.tableName)} (id, slug, status, title, hero, body, sections)
		VALUES (
			${contentId},
			${contentId},
			'published',
			${contentId},
			NULL,
			${JSON.stringify(data.body)},
			${JSON.stringify(data.sections)}
		)
	`.execute(ctx.db);
}

async function updateResourceEntry(
	ctx: DialectTestContext,
	fixture: Awaited<ReturnType<typeof createResourceFixture>>,
	contentId: string,
	data: ReturnType<typeof mediaData>,
): Promise<void> {
	await sql`
		UPDATE ${sql.ref(fixture.tableName)}
		SET body = ${JSON.stringify(data.body)}, sections = ${JSON.stringify(data.sections)}
		WHERE id = ${contentId}
	`.execute(ctx.db);
}

async function addResourceDraft(
	ctx: DialectTestContext,
	fixture: Awaited<ReturnType<typeof createResourceFixture>>,
	contentId: string,
	data: ReturnType<typeof mediaData>,
): Promise<void> {
	const revisionId = `revision-${contentId}`;
	await ctx.db
		.insertInto("revisions")
		.values({
			id: revisionId,
			collection: fixture.collectionSlug,
			entry_id: contentId,
			data: JSON.stringify(data),
			author_id: null,
		})
		.execute();
	await sql`
		UPDATE ${sql.ref(fixture.tableName)}
		SET draft_revision_id = ${revisionId}
		WHERE id = ${contentId}
	`.execute(ctx.db);
}

async function updateResourceDraft(
	ctx: DialectTestContext,
	contentId: string,
	data: ReturnType<typeof mediaData>,
): Promise<void> {
	await ctx.db
		.updateTable("revisions")
		.set({ data: JSON.stringify(data) })
		.where("id", "=", `revision-${contentId}`)
		.execute();
}

function mediaData(count: number, prefix: string) {
	const portableTextCount = Math.ceil(count / 2);
	const repeaterCount = Math.floor(count / 2);
	return {
		body: Array.from({ length: portableTextCount }, (_, index) => ({
			_type: "image",
			_key: `body-${index}`,
			asset: { _ref: `${prefix}-body-${index}` },
		})),
		sections: Array.from({ length: repeaterCount }, (_, index) => ({
			_key: `section-${index}`,
			image: {
				id: `${prefix}-section-${index}`,
				provider: "local",
				mimeType: "image/webp",
			},
		})),
	};
}

function canonicalSourceKey(
	collectionId: string,
	contentId: string,
	sourceVariant = "columns",
): string {
	return `content:${collectionId}:${contentId}:${sourceVariant}`;
}

async function countCurrentOccurrences(db: Kysely<Database>, sourceKey: string): Promise<number> {
	const result = await db
		.selectFrom("_emdash_media_usage as usage")
		.innerJoin("_emdash_media_usage_sources as source", (join) =>
			join
				.onRef("source.source_key", "=", "usage.source_key")
				.onRef("source.current_generation", "=", "usage.generation"),
		)
		.select((eb) => eb.fn.countAll<number>().as("count"))
		.where("source.source_key", "=", sourceKey)
		.executeTakeFirstOrThrow();
	return Number(result.count);
}

async function countStoredOccurrences(db: Kysely<Database>, sourceKey: string): Promise<number> {
	const result = await db
		.selectFrom("_emdash_media_usage")
		.select((eb) => eb.fn.countAll<number>().as("count"))
		.where("source_key", "=", sourceKey)
		.executeTakeFirstOrThrow();
	return Number(result.count);
}

async function countWork(db: Kysely<Database>): Promise<number> {
	const result = await db
		.selectFrom("_emdash_media_usage_work")
		.select((eb) => eb.fn.countAll<number>().as("count"))
		.executeTakeFirstOrThrow();
	return Number(result.count);
}

async function findWork(db: Kysely<Database>) {
	return db.selectFrom("_emdash_media_usage_work").selectAll().executeTakeFirstOrThrow();
}

async function findCoverageStatus(db: Kysely<Database>, collectionId: string) {
	return db
		.selectFrom("_emdash_media_usage_index_status")
		.selectAll()
		.where("collection_id", "=", collectionId)
		.executeTakeFirstOrThrow();
}

async function installProjectionSupersessionTrigger(
	ctx: DialectTestContext,
	contentId: string,
): Promise<void> {
	if (ctx.dialect === "postgres") {
		await sql`
			CREATE OR REPLACE FUNCTION emdash_test_supersede_media_usage_work()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				UPDATE _emdash_media_usage_work
				SET work_version = work_version + 1,
					state = 'pending',
					lease_token = NULL,
					lease_expires_at = NULL,
					next_attempt_at = updated_at
				WHERE content_id = ${sql.lit(contentId)};
				RETURN NEW;
			END;
			$$
		`.execute(ctx.db);
		await sql`
			CREATE TRIGGER emdash_test_supersede_media_usage_work
			AFTER INSERT ON _emdash_media_usage_sources
			FOR EACH ROW EXECUTE FUNCTION emdash_test_supersede_media_usage_work()
		`.execute(ctx.db);
		return;
	}

	await sql`
		CREATE TRIGGER emdash_test_supersede_media_usage_work
		AFTER INSERT ON _emdash_media_usage_sources
		FOR EACH ROW
		BEGIN
			UPDATE _emdash_media_usage_work
			SET work_version = work_version + 1,
				state = 'pending',
				lease_token = NULL,
				lease_expires_at = NULL,
				next_attempt_at = updated_at
			WHERE content_id = ${sql.lit(contentId)};
		END
	`.execute(ctx.db);
}

async function removeProjectionSupersessionTrigger(ctx: DialectTestContext): Promise<void> {
	if (ctx.dialect === "postgres") {
		await sql`
			DROP TRIGGER emdash_test_supersede_media_usage_work
			ON _emdash_media_usage_sources
		`.execute(ctx.db);
		await sql`DROP FUNCTION emdash_test_supersede_media_usage_work()`.execute(ctx.db);
		return;
	}
	await sql`DROP TRIGGER emdash_test_supersede_media_usage_work`.execute(ctx.db);
}
