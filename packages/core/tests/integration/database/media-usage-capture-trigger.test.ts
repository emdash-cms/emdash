import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	installMediaUsageCaptureTriggers,
	removeMediaUsageCaptureTriggers,
} from "../../../src/media/usage/capture-triggers.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const ADAPTER_ID = "content-media";

describeEachDialect("media usage capture triggers", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("coalesces insert, update, and delete into one newest pending job", async () => {
		const fixture = await createActiveFixture(ctx, "posts");

		await insertEntry(ctx, fixture.tableName, "entry-1", "first");
		await ctx.db
			.updateTable("_emdash_media_usage_work")
			.set({
				state: "leased",
				attempt_count: 4,
				next_attempt_at: "2099-01-01T00:00:00.000Z",
				lease_token: "old-owner",
				lease_expires_at: "2099-01-01T00:01:00.000Z",
				last_attempted_at: "2026-08-01T00:00:00.000Z",
				last_error_code: "OLD_ERROR",
			})
			.execute();
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ status: "complete", completed_at: "2026-08-01T00:00:00.000Z" })
			.where("collection_id", "=", fixture.collectionId)
			.execute();

		await sql`UPDATE ${sql.ref(fixture.tableName)} SET slug = 'second' WHERE id = 'entry-1'`.execute(
			ctx.db,
		);
		await sql`DELETE FROM ${sql.ref(fixture.tableName)} WHERE id = 'entry-1'`.execute(ctx.db);

		const status = await ctx.db
			.selectFrom("_emdash_media_usage_index_status")
			.select(["change_epoch", "status", "completed_at"])
			.where("collection_id", "=", fixture.collectionId)
			.executeTakeFirstOrThrow();
		expect({ ...status, change_epoch: Number(status.change_epoch) }).toEqual({
			change_epoch: 3,
			status: "stale",
			completed_at: null,
		});

		const jobs = await ctx.db
			.selectFrom("_emdash_media_usage_work")
			.select([
				"collection_id",
				"content_id",
				"change_epoch",
				"work_version",
				"state",
				"attempt_count",
				"lease_token",
				"lease_expires_at",
				"last_attempted_at",
				"last_error_code",
				"next_attempt_at",
				"updated_at",
			])
			.execute();
		expect(
			jobs.map((job) => ({
				...job,
				change_epoch: Number(job.change_epoch),
				work_version: Number(job.work_version),
			})),
		).toEqual([
			{
				collection_id: fixture.collectionId,
				content_id: "entry-1",
				change_epoch: 3,
				work_version: 3,
				state: "pending",
				attempt_count: 0,
				lease_token: null,
				lease_expires_at: null,
				last_attempted_at: null,
				last_error_code: null,
				next_attempt_at: jobs[0]?.updated_at,
				updated_at: jobs[0]?.updated_at,
			},
		]);
		expect(jobs[0]?.next_attempt_at).not.toBe("2099-01-01T00:00:00.000Z");
	});

	it("rejects writes unless the exact registry and lifecycle identity is active", async () => {
		const fixture = await createActiveFixture(ctx, "articles");
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ capture_state: "installing" })
			.where("collection_id", "=", fixture.collectionId)
			.execute();

		await expect(insertEntry(ctx, fixture.tableName, "entry-1", "entry-1")).rejects.toThrow();
		expect(await countEntries(ctx, fixture.tableName)).toBe(0);
		expect(await countWork(ctx)).toBe(0);

		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ capture_state: "active" })
			.where("collection_id", "=", fixture.collectionId)
			.execute();
		await ctx.db
			.updateTable("_emdash_collections")
			.set({ id: "replacement-collection-id" })
			.where("id", "=", fixture.collectionId)
			.execute();

		await expect(insertEntry(ctx, fixture.tableName, "entry-2", "entry-2")).rejects.toThrow();
		expect(await countEntries(ctx, fixture.tableName)).toBe(0);
		expect(await countWork(ctx)).toBe(0);
	});

	it("rejects a status identity mismatch while the registry identity remains current", async () => {
		const fixture = await createActiveFixture(ctx, "status_mismatch");
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ collection_id: "wrong-status-identity" })
			.where("collection_id", "=", fixture.collectionId)
			.execute();

		await expect(insertEntry(ctx, fixture.tableName, "entry-1", "entry-1")).rejects.toThrow();
		expect(await countEntries(ctx, fixture.tableName)).toBe(0);
		expect(await countWork(ctx)).toBe(0);
	});

	it("is behaviorally idempotent when installed repeatedly", async () => {
		const fixture = await createActiveFixture(ctx, "notes");
		await installMediaUsageCaptureTriggers(ctx.db, {
			collectionId: fixture.collectionId,
			collectionSlug: fixture.collectionSlug,
		});

		await insertEntry(ctx, fixture.tableName, "entry-1", "entry-1");

		const status = await ctx.db
			.selectFrom("_emdash_media_usage_index_status")
			.select("change_epoch")
			.where("collection_id", "=", fixture.collectionId)
			.executeTakeFirstOrThrow();
		const work = await ctx.db
			.selectFrom("_emdash_media_usage_work")
			.select("work_version")
			.executeTakeFirstOrThrow();
		expect(Number(status.change_epoch)).toBe(1);
		expect(Number(work.work_version)).toBe(1);
	});

	it("replaces stale triggers from an interrupted earlier collection identity", async () => {
		const fixture = await createActiveFixture(ctx, "recreated_posts");
		const replacementId = "replacement-collection-id";
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ collection_id: replacementId, capture_state: "installing" })
			.where("collection_id", "=", fixture.collectionId)
			.execute();
		await ctx.db
			.updateTable("_emdash_collections")
			.set({ id: replacementId })
			.where("id", "=", fixture.collectionId)
			.execute();

		await installMediaUsageCaptureTriggers(ctx.db, {
			collectionId: replacementId,
			collectionSlug: fixture.collectionSlug,
		});
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ capture_state: "active" })
			.where("collection_id", "=", replacementId)
			.execute();
		await insertEntry(ctx, fixture.tableName, "entry-1", "entry-1");

		const work = await ctx.db
			.selectFrom("_emdash_media_usage_work")
			.select(["collection_id", "content_id"])
			.execute();
		expect(work).toEqual([{ collection_id: replacementId, content_id: "entry-1" }]);
	});

	it("repairs a same-named disabled or incorrect trigger while fenced", async () => {
		const fixture = await createActiveFixture(ctx, "corrupt_trigger");
		await replaceInsertCaptureWithNoOp(ctx, fixture.tableName);
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ capture_state: "installing" })
			.where("collection_id", "=", fixture.collectionId)
			.execute();

		await installMediaUsageCaptureTriggers(ctx.db, {
			collectionId: fixture.collectionId,
			collectionSlug: fixture.collectionSlug,
		});
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ capture_state: "active" })
			.where("collection_id", "=", fixture.collectionId)
			.execute();
		await insertEntry(ctx, fixture.tableName, "entry-1", "entry-1");
		expect(await countWork(ctx)).toBe(1);
	});

	it("rolls back every row, job, and epoch when one row cannot be captured", async () => {
		const fixture = await createActiveFixture(ctx, "bulk_posts");
		await installRejectingWorkTrigger(ctx, "entry-2");

		await expect(
			sql`
				INSERT INTO ${sql.ref(fixture.tableName)} (id, slug)
				VALUES ('entry-1', 'entry-1'), ('entry-2', 'entry-2')
			`.execute(ctx.db),
		).rejects.toThrow();

		expect(await countEntries(ctx, fixture.tableName)).toBe(0);
		expect(await countWork(ctx)).toBe(0);
		const status = await ctx.db
			.selectFrom("_emdash_media_usage_index_status")
			.select(["change_epoch", "status", "completed_at"])
			.where("collection_id", "=", fixture.collectionId)
			.executeTakeFirstOrThrow();
		expect({ ...status, change_epoch: Number(status.change_epoch) }).toEqual({
			change_epoch: 0,
			status: "complete",
			completed_at: "2026-08-01T00:00:00.000Z",
		});
	});

	it("removes the capture boundary explicitly", async () => {
		const fixture = await createActiveFixture(ctx, "scratch");
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ capture_state: "deleting" })
			.where("collection_id", "=", fixture.collectionId)
			.execute();
		await removeMediaUsageCaptureTriggers(ctx.db, {
			collectionId: fixture.collectionId,
			collectionSlug: fixture.collectionSlug,
		});

		await insertEntry(ctx, fixture.tableName, "entry-1", "entry-1");
		expect(await countEntries(ctx, fixture.tableName)).toBe(1);
		expect(await countWork(ctx)).toBe(0);
	});

	it("refuses rollback after capture is active and leaves writes protected", async () => {
		const fixture = await createActiveFixture(ctx, "protected_posts");
		const migration =
			await import("../../../src/database/migrations/063_media_usage_incremental_work.js");

		await expect(migration.down(ctx.db)).rejects.toThrow(/cannot roll back media usage capture/i);
		await insertEntry(ctx, fixture.tableName, "entry-1", "entry-1");
		expect(await countEntries(ctx, fixture.tableName)).toBe(1);
		expect(await countWork(ctx)).toBe(1);
	});
});

async function createActiveFixture(ctx: DialectTestContext, collectionSlug: string) {
	const registry = new SchemaRegistry(ctx.db);
	await registry.createCollection({ slug: collectionSlug, label: collectionSlug });
	const collection = await registry.getCollection(collectionSlug);
	if (!collection) throw new Error(`Expected ${collectionSlug} collection`);

	await ctx.db
		.insertInto("_emdash_media_usage_index_status")
		.values({
			adapter_id: ADAPTER_ID,
			scope_type: "collection",
			scope_key: collectionSlug,
			collection_id: collection.id,
			status: "complete",
			completed_at: "2026-08-01T00:00:00.000Z",
			reconciliation_required: 0,
			capture_state: "installing",
		})
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

	return {
		collectionId: collection.id,
		collectionSlug,
		tableName: `ec_${collectionSlug}`,
	};
}

async function insertEntry(
	ctx: DialectTestContext,
	tableName: string,
	id: string,
	slug: string,
): Promise<void> {
	await sql`INSERT INTO ${sql.ref(tableName)} (id, slug) VALUES (${id}, ${slug})`.execute(ctx.db);
}

async function countEntries(ctx: DialectTestContext, tableName: string): Promise<number> {
	const result = await sql<{ count: number }>`
		SELECT COUNT(*) AS count FROM ${sql.ref(tableName)}
	`.execute(ctx.db);
	return Number(result.rows[0]?.count ?? 0);
}

async function countWork(ctx: DialectTestContext): Promise<number> {
	const result = await ctx.db
		.selectFrom("_emdash_media_usage_work")
		.select((eb) => eb.fn.countAll<number>().as("count"))
		.executeTakeFirstOrThrow();
	return Number(result.count);
}

async function installRejectingWorkTrigger(
	ctx: DialectTestContext,
	rejectedContentId: string,
): Promise<void> {
	if (ctx.dialect === "postgres") {
		await sql`
			CREATE OR REPLACE FUNCTION emdash_test_reject_media_usage_work()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				IF NEW.content_id = ${sql.lit(rejectedContentId)} THEN
					RAISE EXCEPTION 'forced work failure';
				END IF;
				RETURN NEW;
			END;
			$$
		`.execute(ctx.db);
		await sql`
			CREATE TRIGGER emdash_test_reject_media_usage_work
			BEFORE INSERT OR UPDATE ON _emdash_media_usage_work
			FOR EACH ROW EXECUTE FUNCTION emdash_test_reject_media_usage_work()
		`.execute(ctx.db);
		return;
	}

	await sql`
		CREATE TRIGGER emdash_test_reject_media_usage_work
		BEFORE INSERT ON _emdash_media_usage_work
		FOR EACH ROW
		WHEN NEW.content_id = ${sql.lit(rejectedContentId)}
		BEGIN
			SELECT RAISE(ABORT, 'forced work failure');
		END
	`.execute(ctx.db);
}

async function replaceInsertCaptureWithNoOp(
	ctx: DialectTestContext,
	tableName: string,
): Promise<void> {
	const triggerName = await findInsertCaptureTrigger(ctx, tableName);
	if (ctx.dialect === "postgres") {
		await sql`
			ALTER TABLE ${sql.ref(tableName)} DISABLE TRIGGER ${sql.ref(triggerName)}
		`.execute(ctx.db);
		return;
	}

	await sql`DROP TRIGGER ${sql.ref(triggerName)}`.execute(ctx.db);
	await sql`
		CREATE TRIGGER ${sql.ref(triggerName)}
		AFTER INSERT ON ${sql.ref(tableName)}
		FOR EACH ROW BEGIN SELECT 1; END
	`.execute(ctx.db);
}

async function findInsertCaptureTrigger(
	ctx: DialectTestContext,
	tableName: string,
): Promise<string> {
	if (ctx.dialect === "postgres") {
		const result = await sql<{ name: string }>`
			SELECT trigger.tgname AS name
			FROM pg_trigger AS trigger
			INNER JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
			INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
			WHERE namespace.nspname = current_schema()
				AND relation.relname = ${tableName}
				AND trigger.tgtype = 5
				AND NOT trigger.tgisinternal
		`.execute(ctx.db);
		const name = result.rows[0]?.name;
		if (!name) throw new Error("Expected PostgreSQL insert capture trigger");
		return name;
	}

	const result = await sql<{ name: string }>`
		SELECT name FROM sqlite_master
		WHERE type = 'trigger'
			AND tbl_name = ${tableName}
			AND sql LIKE '%AFTER INSERT%'
	`.execute(ctx.db);
	const name = result.rows[0]?.name;
	if (!name) throw new Error("Expected SQLite insert capture trigger");
	return name;
}
