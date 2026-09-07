import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaUsageRepository } from "../../../src/database/repositories/media-usage.js";
import { processClaimedMediaUsageReconciliationScan } from "../../../src/media/usage/reconciliation-processor.js";
import { MediaUsageReconciliationRepository } from "../../../src/media/usage/reconciliation.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media usage reconciliation scan", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("pages through the captured bound without resetting equal or newer work", async () => {
		const collection = await createScanCollection(ctx, 51);
		await ctx.db
			.insertInto("_emdash_media_usage_work")
			.values([
				{
					collection_id: collection.id,
					collection_slug: collection.slug,
					content_id: "entry-001",
					change_epoch: 0,
					state: "failed",
					next_attempt_at: "2000-01-01T00:00:00.000Z",
					last_error_code: "OLD_FAILURE",
				},
				{
					collection_id: collection.id,
					collection_slug: collection.slug,
					content_id: "entry-002",
					change_epoch: 99,
					state: "failed",
					next_attempt_at: "2000-01-01T00:00:00.000Z",
					last_error_code: "NEWER_FAILURE",
				},
			])
			.execute();

		await expect(claimAndScan(ctx)).resolves.toBe("advanced");
		const coordinator = await ctx.db
			.selectFrom("_emdash_media_usage_reconciliations")
			.select(["target_epoch", "field_fingerprint", "scan_upper_id", "scan_cursor"])
			.where("collection_id", "=", collection.id)
			.executeTakeFirstOrThrow();
		expect(Number(coordinator.target_epoch)).toBe(1);
		expect(coordinator).toMatchObject({
			scan_upper_id: "entry-050",
			scan_cursor: "entry-050",
		});
		expect(coordinator.field_fingerprint).toMatch(/^media-usage-fields:v1:sha256:[a-f0-9]{64}$/);
		const workCount = await ctx.db
			.selectFrom("_emdash_media_usage_work")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("collection_id", "=", collection.id)
			.executeTakeFirstOrThrow();
		expect(Number(workCount.count)).toBe(51);
		expect(await workState(ctx, collection.id, "entry-001")).toMatchObject({
			change_epoch: 1,
			work_version: 2,
			state: "pending",
			last_error_code: null,
		});
		expect(await workState(ctx, collection.id, "entry-002")).toMatchObject({
			change_epoch: 99,
			work_version: 1,
			state: "failed",
			last_error_code: "NEWER_FAILURE",
		});

		const versionsBeforeReplay = await workVersions(ctx, collection.id);
		await ctx.db
			.updateTable("_emdash_media_usage_reconciliations")
			.set({ scan_cursor: null, state: "pending", next_attempt_at: "2000-01-01T00:00:00.000Z" })
			.where("collection_id", "=", collection.id)
			.execute();
		await expect(claimAndScan(ctx)).resolves.toBe("advanced");
		expect(await workVersions(ctx, collection.id)).toEqual(versionsBeforeReplay);

		await expect(claimAndScan(ctx)).resolves.toBe("exhausted");
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_reconciliations")
				.select("scan_cursor")
				.where("collection_id", "=", collection.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ scan_cursor: "entry-050" });
	});

	it("invalidates stale canonical publication after deletion or a newer version", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "guarded", label: "Guarded" });
		const collection = await registry.getCollection("guarded");
		if (!collection) throw new Error("Expected guarded collection");
		await sql`
			INSERT INTO ${sql.ref("ec_guarded")} (id, slug, version, updated_at)
			VALUES ('entry-1', 'entry-1', 1, '2026-08-12T10:00:00.000Z')
		`.execute(ctx.db);
		const repository = new MediaUsageRepository(ctx.db);
		const source = canonicalSource(collection.id, 1, "2026-08-12T10:00:00.000Z");

		await sql`DELETE FROM ${sql.ref("ec_guarded")} WHERE id = 'entry-1'`.execute(ctx.db);
		await expect(repository.replaceSourceIfMatching(source, [], null)).resolves.toMatchObject({
			replaced: false,
		});
		expect(await repository.findSource(source.sourceKey)).toBeNull();

		await sql`
			INSERT INTO ${sql.ref("ec_guarded")} (id, slug, version, updated_at)
			VALUES ('entry-1', 'entry-1', 2, '2026-08-12T10:05:00.000Z')
		`.execute(ctx.db);
		await expect(repository.replaceSourceIfMatching(source, [], null)).resolves.toMatchObject({
			replaced: false,
		});
		expect(await repository.findSource(source.sourceKey)).toBeNull();

		await ctx.db
			.insertInto("revisions")
			.values({
				id: "live-2",
				collection: "guarded",
				entry_id: "entry-1",
				data: "{}",
				author_id: null,
			})
			.execute();
		await sql`
			UPDATE ${sql.ref("ec_guarded")}
			SET live_revision_id = 'live-2'
			WHERE id = 'entry-1'
		`.execute(ctx.db);
		const staleRevision = canonicalSource(
			collection.id,
			2,
			"2026-08-12T10:05:00.000Z",
			"guarded",
			"live-1",
		);
		await expect(
			repository.replaceSourceIfMatching(staleRevision, [], null),
		).resolves.toMatchObject({ replaced: false });

		const current = canonicalSource(
			collection.id,
			2,
			"2026-08-12T10:05:00.000Z",
			"guarded",
			"live-2",
		);
		await expect(repository.replaceSourceIfMatching(current, [], null)).resolves.toMatchObject({
			replaced: true,
		});
	});

	it("skips content work when the collection has no media-bearing fields", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "plain", label: "Plain" });
		const collection = await registry.getCollection("plain");
		if (!collection) throw new Error("Expected plain collection");
		await sql`INSERT INTO ${sql.ref("ec_plain")} (id, slug) VALUES ('entry-1', 'entry-1')`.execute(
			ctx.db,
		);
		await activateCollection(ctx, collection);

		await expect(claimAndScan(ctx)).resolves.toBe("exhausted");
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_work")
				.select("content_id")
				.where("collection_id", "=", collection.id)
				.execute(),
		).toEqual([]);
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_reconciliations")
				.select("scan_upper_id")
				.where("collection_id", "=", collection.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ scan_upper_id: null });
	});

	it("applies the content identity guard to attempted canonical sources", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "attempted", label: "Attempted" });
		const collection = await registry.getCollection("attempted");
		if (!collection) throw new Error("Expected attempted collection");
		await sql`
			INSERT INTO ${sql.ref("ec_attempted")} (id, slug, version, updated_at)
			VALUES ('entry-1', 'entry-1', 2, '2026-08-12T10:05:00.000Z')
		`.execute(ctx.db);
		const repository = new MediaUsageRepository(ctx.db);
		const stale = {
			...canonicalSource(collection.id, 1, "2026-08-12T10:00:00.000Z", "attempted"),
			lastErrorCode: "DRAFT_REVISION_NOT_FOUND",
		};

		await expect(repository.markSourceAttemptedIfMatching(stale, null)).resolves.toMatchObject({
			attempted: false,
		});
		expect(await repository.findSource(stale.sourceKey)).toBeNull();
	});
});

async function createScanCollection(
	ctx: DialectTestContext,
	entryCount: number,
): Promise<{ id: string; slug: string }> {
	const registry = new SchemaRegistry(ctx.db);
	await registry.createCollection({ slug: "articles", label: "Articles" });
	await registry.createField("articles", { slug: "hero", label: "Hero", type: "image" });
	const collection = await registry.getCollection("articles");
	if (!collection) throw new Error("Expected articles collection");
	for (let index = 0; index < entryCount; index++) {
		const id = `entry-${String(index).padStart(3, "0")}`;
		await sql`INSERT INTO ${sql.ref("ec_articles")} (id, slug) VALUES (${id}, ${id})`.execute(
			ctx.db,
		);
	}
	await activateCollection(ctx, collection);
	return { id: collection.id, slug: collection.slug };
}

async function activateCollection(
	ctx: DialectTestContext,
	collection: { id: string; slug: string },
): Promise<void> {
	await ctx.db
		.insertInto("_emdash_media_usage_index_status")
		.values({
			adapter_id: "content-media",
			scope_type: "collection",
			scope_key: collection.slug,
			collection_id: collection.id,
			status: "stale",
			capture_state: "active",
			reconciliation_required: 1,
		})
		.onConflict((conflict) =>
			conflict.columns(["adapter_id", "scope_type", "scope_key"]).doUpdateSet({
				collection_id: collection.id,
				status: "stale",
				capture_state: "active",
				reconciliation_required: 1,
			}),
		)
		.execute();
	await ctx.db
		.updateTable("_emdash_media_usage_activation")
		.set({ state: "active" })
		.where("task_key", "=", "incremental_capture")
		.execute();
	const repository = new MediaUsageReconciliationRepository(ctx.db);
	await repository.seedNextCandidate();
}

async function claimAndScan(ctx: DialectTestContext) {
	const repository = new MediaUsageReconciliationRepository(ctx.db);
	const [candidate] = await repository.findDue(4);
	if (!candidate) throw new Error("Expected a due reconciliation candidate");
	const claim = await repository.claim({
		collectionId: candidate.collectionId,
		runToken: candidate.runToken,
		leaseDurationSeconds: 60,
	});
	if (!claim) throw new Error("Expected a reconciliation claim");
	return processClaimedMediaUsageReconciliationScan(ctx.db, claim);
}

function canonicalSource(
	collectionId: string,
	version: number,
	updatedAt: string,
	collectionSlug = "guarded",
	revisionId: string | null = null,
) {
	return {
		sourceKey: `content-id:${collectionId}:entry-1:columns`,
		sourceType: "content",
		collectionId,
		collectionSlug,
		contentId: "entry-1",
		sourceVariant: "columns" as const,
		revisionId,
		sourceVersion: version,
		sourceUpdatedAt: updatedAt,
		identityVersion: 1,
	};
}

async function workState(ctx: DialectTestContext, collectionId: string, contentId: string) {
	const row = await ctx.db
		.selectFrom("_emdash_media_usage_work")
		.select(["change_epoch", "work_version", "state", "last_error_code"])
		.where("collection_id", "=", collectionId)
		.where("content_id", "=", contentId)
		.executeTakeFirstOrThrow();
	return {
		...row,
		change_epoch: Number(row.change_epoch),
		work_version: Number(row.work_version),
	};
}

async function workVersions(ctx: DialectTestContext, collectionId: string) {
	return ctx.db
		.selectFrom("_emdash_media_usage_work")
		.select(["content_id", "work_version"])
		.where("collection_id", "=", collectionId)
		.orderBy("content_id")
		.execute();
}
