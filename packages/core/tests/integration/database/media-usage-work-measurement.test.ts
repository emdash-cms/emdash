import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import { MediaUsageWorkRepository } from "../../../src/database/repositories/media-usage-work.js";
import type { Database as DatabaseSchema } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { installMediaUsageCaptureTriggers } from "../../../src/media/usage/capture-triggers.js";
import {
	processDueMediaUsageWork,
	processMediaUsageWorkAfterWrite,
} from "../../../src/media/usage/work-processor.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";

interface CapturedQuery {
	sql: string;
	parameters: readonly unknown[];
}

interface Measurement {
	statements: number;
	d1EquivalentStatements: number;
	maxBinds: number;
	changedRows: number;
	durationMs: number;
}

let sqlite: Database.Database;
let db: Kysely<DatabaseSchema>;
let captured: CapturedQuery[];
let fixture: Awaited<ReturnType<typeof createActiveFixture>>;

beforeEach(async () => {
	setI18nConfig(null);
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
	fixture = await createActiveFixture();
});

afterEach(async () => {
	setI18nConfig(null);
	await db.destroy();
});

it("measures complete changed jobs as portable-text and repeater occurrences grow", async () => {
	let previousStatementCount = 0;
	for (const occurrenceCount of [0, 1, 7, 8, 14]) {
		const contentId = `columns-${occurrenceCount}`;
		await insertEntry(contentId, mediaData(occurrenceCount, contentId));

		const { value, measurement } = await measure(() =>
			processMediaUsageWorkAfterWrite(db, fixture.collectionSlug, contentId),
		);

		expect(value.outcome).toBe("completed");
		expect(measurement.maxBinds).toBeLessThanOrEqual(100);
		expect(measurement.statements).toBeGreaterThanOrEqual(previousStatementCount);
		previousStatementCount = measurement.statements;
	}
});

it("measures complete changed jobs with columns and draft-overlay sources", async () => {
	let previousStatementCount = 0;
	for (const occurrencesPerSource of [0, 7, 14]) {
		const contentId = `both-${occurrencesPerSource}`;
		await insertEntry(contentId, mediaData(occurrencesPerSource, `${contentId}-columns`));
		await addDraft(contentId, mediaData(occurrencesPerSource, `${contentId}-draft`));

		const { value, measurement } = await measure(() =>
			processMediaUsageWorkAfterWrite(db, fixture.collectionSlug, contentId),
		);

		expect(value.outcome).toBe("completed");
		expect(measurement.maxBinds).toBeLessThanOrEqual(100);
		expect(measurement.statements).toBeGreaterThanOrEqual(previousStatementCount);
		previousStatementCount = measurement.statements;
	}
});

it("keeps the largest admitted scheduled job inside the Free-plan query budget", async () => {
	const contentId = "scheduled-boundary";
	await insertEntry(contentId, mediaData(14, "scheduled-columns"));
	await addDraft(contentId, mediaData(14, "scheduled-draft"));

	const result = await measure(() => processDueMediaUsageWork(db));

	expect(result.value.completedCount).toBe(1);
	expect(result.measurement.d1EquivalentStatements).toBeLessThanOrEqual(40);
	expect(result.measurement.maxBinds).toBeLessThanOrEqual(100);
});

it("measures worst-position guarded conflicts across one and two sources", async () => {
	const oneSourceCounts = [7, 14];
	for (const occurrenceCount of oneSourceCounts) {
		const contentId = `conflict-one-${occurrenceCount}`;
		await insertEntry(contentId, mediaData(occurrenceCount, `${contentId}-initial`));
		await processMediaUsageWorkAfterWrite(db, fixture.collectionSlug, contentId);
		await updateEntry(contentId, mediaData(occurrenceCount, `${contentId}-changed`));
	}
	await installAnySourceConflictTrigger();
	try {
		for (const occurrenceCount of oneSourceCounts) {
			const contentId = `conflict-one-${occurrenceCount}`;
			const result = await measure(() =>
				processMediaUsageWorkAfterWrite(db, fixture.collectionSlug, contentId),
			);
			expect(result.value.outcome).toBe("retry");
			expect(result.measurement.maxBinds).toBeLessThanOrEqual(100);
		}
	} finally {
		await sql`DROP TRIGGER measure_any_generation_conflict`.execute(db);
	}

	const perSourceCounts = [7, 14];
	for (const occurrenceCount of perSourceCounts) {
		const contentId = `conflict-both-${occurrenceCount}`;
		await insertEntry(contentId, mediaData(occurrenceCount, `${contentId}-columns-initial`));
		await addDraft(contentId, mediaData(occurrenceCount, `${contentId}-draft-initial`));
		await processMediaUsageWorkAfterWrite(db, fixture.collectionSlug, contentId);
		await updateEntry(contentId, mediaData(occurrenceCount, `${contentId}-columns-changed`));
		await updateDraft(contentId, mediaData(occurrenceCount, `${contentId}-draft-changed`));
	}
	await installDraftSourceConflictTrigger();
	try {
		for (const occurrenceCount of perSourceCounts) {
			const contentId = `conflict-both-${occurrenceCount}`;
			const result = await measure(() =>
				processMediaUsageWorkAfterWrite(db, fixture.collectionSlug, contentId),
			);
			expect(result.value.outcome).toBe("retry");
			expect(result.measurement.maxBinds).toBeLessThanOrEqual(100);
		}
	} finally {
		await sql`DROP TRIGGER measure_draft_generation_conflict`.execute(db);
	}
});

it("measures the complete runtime create and draft-update invocation", async () => {
	const runtime = createTestRuntime(db);

	for (const occurrenceCount of [0, 7, 14]) {
		const slug = `runtime-${occurrenceCount}`;
		const created = await measure(() =>
			runtime.handleContentCreate(fixture.collectionSlug, {
				slug,
				data: { title: slug, ...mediaData(occurrenceCount, `${slug}-live`) },
			}),
		);
		expect(created.value.success).toBe(true);
		if (!created.value.success) throw new Error(created.value.error.message);
		expect(created.measurement.maxBinds).toBeLessThanOrEqual(100);

		const updated = await measure(() =>
			runtime.handleContentUpdate(fixture.collectionSlug, created.value.data.item.id, {
				data: mediaData(occurrenceCount, `${slug}-draft`),
			}),
		);
		expect(updated.value.success).toBe(true);
		expect(updated.measurement.maxBinds).toBeLessThanOrEqual(100);
		if (occurrenceCount === 14) {
			expect(updated.measurement.d1EquivalentStatements).toBeLessThanOrEqual(41);
		}
	}
});

it("keeps translated sibling work out of the saved entry's immediate budget", async () => {
	setI18nConfig({ defaultLocale: "en", locales: ["en", "fr", "de", "es"] });
	const localized = await createActiveLocalizedFixture();
	const runtime = createTestRuntime(db);
	let rootId = "";
	for (const locale of ["en", "fr", "de", "es"]) {
		const created = await runtime.handleContentCreate(localized.collectionSlug, {
			slug: `localized-${locale}`,
			locale,
			translationOf: rootId || undefined,
			data: {
				title: locale,
				shared_body: mediaData(1, `initial-${locale}`).body,
			},
		});
		expect(created.success).toBe(true);
		if (!created.success) throw new Error(created.error.message);
		if (!rootId) rootId = created.data.item.id;
	}

	const updated = await measure(() =>
		runtime.handleContentUpdate(localized.collectionSlug, rootId, {
			data: { shared_body: mediaData(14, "shared").body },
		}),
	);

	expect(updated.value.success).toBe(true);
	expect(updated.measurement.d1EquivalentStatements).toBeLessThanOrEqual(41);
	expect(updated.measurement.maxBinds).toBeLessThanOrEqual(100);
	const remaining = await db
		.selectFrom("_emdash_media_usage_work")
		.select(["content_id", "state"])
		.where("collection_id", "=", localized.collectionId)
		.orderBy("content_id")
		.execute();
	expect(remaining).toHaveLength(3);
	expect(remaining.every((work) => work.state === "pending")).toBe(true);
});

it("measures the worst source split for candidate total-occurrence budgets", async () => {
	const runtime = createTestRuntime(db);
	const worst: Record<number, number> = {};

	for (const totalOccurrences of [14, 15, 21, 28]) {
		const minimumLiveOccurrences = Math.max(0, totalOccurrences - 14);
		const maximumLiveOccurrences = Math.min(14, totalOccurrences);
		for (
			let liveOccurrences = minimumLiveOccurrences;
			liveOccurrences <= maximumLiveOccurrences;
			liveOccurrences++
		) {
			const draftOccurrences = totalOccurrences - liveOccurrences;
			const slug = `split-${totalOccurrences}-${liveOccurrences}`;
			const created = await runtime.handleContentCreate(fixture.collectionSlug, {
				slug,
				data: { title: slug, ...mediaData(liveOccurrences, `${slug}-live`) },
			});
			expect(created.success).toBe(true);
			if (!created.success) throw new Error(created.error.message);

			const updated = await measure(() =>
				runtime.handleContentUpdate(fixture.collectionSlug, created.data.item.id, {
					data: mediaData(draftOccurrences, `${slug}-draft`),
				}),
			);
			expect(updated.value.success).toBe(true);
			if (updated.measurement.d1EquivalentStatements > (worst[totalOccurrences] ?? 0)) {
				worst[totalOccurrences] = updated.measurement.d1EquivalentStatements;
			}
		}
	}

	for (const totalOccurrences of [14, 15, 21, 28]) {
		expect(worst[totalOccurrences]).toBeLessThanOrEqual(41);
	}
});

it("measures complete runtime lifecycle invocations", async () => {
	const runtime = createTestRuntime(db);
	const results: Record<string, Measurement> = {};

	const publishEntry = await runtime.handleContentCreate(fixture.collectionSlug, {
		slug: "lifecycle-publish",
		data: { title: "Publish", ...mediaData(0, "publish-live") },
	});
	if (!publishEntry.success) throw new Error(publishEntry.error.message);
	await runtime.handleContentUpdate(fixture.collectionSlug, publishEntry.data.item.id, {
		data: mediaData(14, "publish-draft"),
	});
	const published = await measure(() =>
		runtime.handleContentPublish(fixture.collectionSlug, publishEntry.data.item.id),
	);
	expect(published.value.success).toBe(true);
	results.publish = published.measurement;

	const unpublished = await measure(() =>
		runtime.handleContentUnpublish(fixture.collectionSlug, publishEntry.data.item.id),
	);
	expect(unpublished.value.success).toBe(true);
	results.unpublish = unpublished.measurement;

	const scheduled = await measure(() =>
		runtime.handleContentSchedule(
			fixture.collectionSlug,
			publishEntry.data.item.id,
			"2100-01-01T00:00:00.000Z",
		),
	);
	expect(scheduled.value.success).toBe(true);
	results.schedule = scheduled.measurement;

	const unscheduled = await measure(() =>
		runtime.handleContentUnschedule(fixture.collectionSlug, publishEntry.data.item.id),
	);
	expect(unscheduled.value.success).toBe(true);
	results.unschedule = unscheduled.measurement;

	const trashed = await measure(() =>
		runtime.handleContentDelete(fixture.collectionSlug, publishEntry.data.item.id),
	);
	expect(trashed.value.success).toBe(true);
	results.trash = trashed.measurement;

	const restored = await measure(() =>
		runtime.handleContentRestore(fixture.collectionSlug, publishEntry.data.item.id),
	);
	expect(restored.value.success).toBe(true);
	results.restore = restored.measurement;

	const trashedAgain = await runtime.handleContentDelete(
		fixture.collectionSlug,
		publishEntry.data.item.id,
	);
	expect(trashedAgain.success).toBe(true);
	const permanentlyDeleted = await measure(() =>
		runtime.handleContentPermanentDelete(fixture.collectionSlug, publishEntry.data.item.id),
	);
	expect(permanentlyDeleted.value.success).toBe(true);
	results.permanentDelete = permanentlyDeleted.measurement;

	expect(results.publish?.d1EquivalentStatements).toBeLessThanOrEqual(33);
	expect(results.unpublish?.d1EquivalentStatements).toBeLessThanOrEqual(39);
	expect(results.schedule?.d1EquivalentStatements).toBeLessThanOrEqual(35);
	expect(results.unschedule?.d1EquivalentStatements).toBeLessThanOrEqual(35);
	expect(results.trash?.d1EquivalentStatements).toBeLessThanOrEqual(32);
	expect(results.restore?.d1EquivalentStatements).toBeLessThanOrEqual(32);
	expect(results.permanentDelete?.d1EquivalentStatements).toBeLessThanOrEqual(22);
	for (const measurement of Object.values(results)) {
		expect(measurement.maxBinds).toBeLessThanOrEqual(100);
	}
});

it("measures no-op, changed, conflict, absence, and dense-backlog paths", async () => {
	const contentId = "path-matrix";
	await insertEntry(contentId, mediaData(14, "path-columns-initial"));
	await addDraft(contentId, mediaData(14, "path-draft-initial"));
	await processMediaUsageWorkAfterWrite(db, fixture.collectionSlug, contentId);

	await updateEntry(contentId, mediaData(14, "path-columns-initial"));
	const noOp = await measure(() =>
		processMediaUsageWorkAfterWrite(db, fixture.collectionSlug, contentId),
	);
	expect(noOp.value.outcome).toBe("completed");

	await updateEntry(contentId, mediaData(14, "path-columns-changed"));
	await updateDraft(contentId, mediaData(14, "path-draft-changed"));
	const changed = await measure(() =>
		processMediaUsageWorkAfterWrite(db, fixture.collectionSlug, contentId),
	);
	expect(changed.value.outcome).toBe("completed");

	const conflictId = "path-conflict";
	await insertEntry(conflictId, mediaData(14, "conflict-initial"));
	await processMediaUsageWorkAfterWrite(db, fixture.collectionSlug, conflictId);
	await updateEntry(conflictId, mediaData(14, "conflict-changed"));
	await installGenerationConflictTrigger();
	let conflict: {
		value: Awaited<ReturnType<typeof processMediaUsageWorkAfterWrite>>;
		measurement: Measurement;
	} | null = null;
	try {
		conflict = await measure(() =>
			processMediaUsageWorkAfterWrite(db, fixture.collectionSlug, conflictId),
		);
		expect(conflict.value.outcome).toBe("retry");
	} finally {
		await sql`DROP TRIGGER measure_generation_conflict`.execute(db);
	}
	if (!conflict) throw new Error("Expected conflict measurement");

	const absentId = "path-absent";
	await insertEntry(absentId, mediaData(14, "absent"));
	await addDraft(absentId, mediaData(14, "absent-draft"));
	await processMediaUsageWorkAfterWrite(db, fixture.collectionSlug, absentId);
	await sql`DELETE FROM ${sql.ref(fixture.tableName)} WHERE id = ${absentId}`.execute(db);
	const absent = await measure(() =>
		processMediaUsageWorkAfterWrite(db, fixture.collectionSlug, absentId),
	);
	expect(absent.value.outcome).toBe("completed");

	const oversizedId = "path-oversized";
	await insertEntry(oversizedId, mediaData(15, "oversized"));
	const oversized = await measure(() =>
		processMediaUsageWorkAfterWrite(db, fixture.collectionSlug, oversizedId),
	);
	expect(oversized.value.outcome).toBe("failed");

	for (let index = 0; index < 120; index++) {
		await insertEntry(`backlog-${index}`, mediaData(1, `backlog-${index}`));
	}
	const backlog = await measure(() => processDueMediaUsageWork(db));
	expect(backlog.value.candidateCount).toBe(4);
	expect(backlog.value.claimedCount).toBe(1);

	for (const result of [noOp, changed, conflict, absent, oversized, backlog]) {
		expect(result.measurement.maxBinds).toBeLessThanOrEqual(100);
	}
	expect(noOp.measurement.d1EquivalentStatements).toBeLessThanOrEqual(15);
	expect(changed.measurement.d1EquivalentStatements).toBeLessThanOrEqual(32);
	expect(conflict.measurement.d1EquivalentStatements).toBeLessThanOrEqual(45);
	expect(absent.measurement.d1EquivalentStatements).toBeLessThanOrEqual(21);
	expect(oversized.measurement.d1EquivalentStatements).toBeLessThanOrEqual(20);
	expect(backlog.measurement.d1EquivalentStatements).toBeLessThanOrEqual(20);
});

it("keeps operator pages bounded and on the operator index", async () => {
	for (let index = 0; index < 128; index++) {
		await insertOperatorWork(
			`operator-${String(index).padStart(3, "0")}`,
			["pending", "retry", "leased", "failed"][index % 4] as
				| "pending"
				| "retry"
				| "leased"
				| "failed",
			`2026-08-06T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
		);
	}

	const repo = new MediaUsageWorkRepository(db);
	const filtered = await measure(() =>
		repo.findOperatorPage({ collectionSlug: fixture.collectionSlug, state: "failed", limit: 50 }),
	);
	expect(filtered.value?.items).toHaveLength(32);
	expect(filtered.measurement.d1EquivalentStatements).toBe(2);
	expectOperatorPlans(filtered.queries, 1);

	const unfiltered = await measure(() =>
		repo.findOperatorPage({ collectionSlug: fixture.collectionSlug, limit: 50 }),
	);
	expect(unfiltered.value?.items).toHaveLength(50);
	expect(unfiltered.value?.nextCursor).toEqual(expect.any(String));
	expect(unfiltered.measurement.d1EquivalentStatements).toBe(5);
	expectOperatorPlans(unfiltered.queries, 4);
});

it("bounds every operator retry outcome", async () => {
	const repo = new MediaUsageWorkRepository(db);
	await insertOperatorWork("retry-pending", "pending", "2026-08-06T12:00:00.000Z");
	const pending = await measure(() =>
		repo.retryOperatorWork({ collectionId: fixture.collectionId, contentId: "retry-pending" }),
	);
	expect(pending.value).toEqual(expect.objectContaining({ outcome: "pending", changed: false }));
	expect(pending.measurement.d1EquivalentStatements).toBe(2);

	await insertOperatorWork("retry-failed", "failed", "2026-08-06T12:00:01.000Z");
	const failed = await measure(() =>
		repo.retryOperatorWork({ collectionId: fixture.collectionId, contentId: "retry-failed" }),
	);
	expect(failed.value).toEqual(expect.objectContaining({ outcome: "pending", changed: true }));
	expect(failed.measurement.d1EquivalentStatements).toBeLessThanOrEqual(4);

	await insertOperatorWork("retry-expired", "leased", "2026-08-06T12:00:02.000Z");
	await db
		.updateTable("_emdash_media_usage_work")
		.set({ lease_expires_at: "2000-01-01T00:00:00.000Z" })
		.where("collection_id", "=", fixture.collectionId)
		.where("content_id", "=", "retry-expired")
		.execute();
	const expired = await measure(() =>
		repo.retryOperatorWork({ collectionId: fixture.collectionId, contentId: "retry-expired" }),
	);
	expect(expired.value).toEqual(expect.objectContaining({ outcome: "pending", changed: true }));
	expect(expired.measurement.d1EquivalentStatements).toBeLessThanOrEqual(4);

	await insertOperatorWork("retry-live", "leased", "2026-08-06T12:00:03.000Z");
	const live = await measure(() =>
		repo.retryOperatorWork({ collectionId: fixture.collectionId, contentId: "retry-live" }),
	);
	expect(live.value).toEqual(
		expect.objectContaining({ outcome: "lease_active", leaseExpiresAt: expect.any(String) }),
	);
	expect(live.measurement.d1EquivalentStatements).toBeLessThanOrEqual(7);

	const missing = await measure(() =>
		repo.retryOperatorWork({ collectionId: fixture.collectionId, contentId: "retry-missing" }),
	);
	expect(missing.value).toEqual(expect.objectContaining({ outcome: "pending", changed: true }));
	expect(missing.measurement.d1EquivalentStatements).toBeLessThanOrEqual(4);

	await insertOperatorWork("retry-conflict", "failed", "2026-08-06T12:00:04.000Z");
	await sql`
		CREATE TRIGGER measure_operator_retry_conflict
		AFTER UPDATE OF change_epoch ON _emdash_media_usage_index_status
		BEGIN
			DELETE FROM _emdash_media_usage_work
			WHERE content_id = 'retry-conflict';
		END
	`.execute(db);
	try {
		const conflict = await measure(() =>
			repo.retryOperatorWork({ collectionId: fixture.collectionId, contentId: "retry-conflict" }),
		);
		expect(conflict.value).toEqual({ outcome: "conflict" });
		expect(conflict.measurement.d1EquivalentStatements).toBeLessThanOrEqual(7);
	} finally {
		await sql`DROP TRIGGER measure_operator_retry_conflict`.execute(db);
	}
});

async function createActiveFixture() {
	const collectionSlug = "measured_jobs";
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: collectionSlug, label: "Measured jobs" });
	await registry.createField(collectionSlug, { slug: "title", label: "Title", type: "string" });
	await registry.createField(collectionSlug, {
		slug: "body",
		label: "Body",
		type: "portableText",
	});
	await registry.createField(collectionSlug, {
		slug: "sections",
		label: "Sections",
		type: "repeater",
		validation: { subFields: [{ slug: "image", type: "image", label: "Image" }] },
	});
	const collection = await registry.getCollection(collectionSlug);
	if (!collection) throw new Error("Expected measured collection");

	await db
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
	await installMediaUsageCaptureTriggers(db, {
		collectionId: collection.id,
		collectionSlug,
	});
	await db
		.updateTable("_emdash_media_usage_index_status")
		.set({ capture_state: "active" })
		.where("collection_id", "=", collection.id)
		.execute();
	await db
		.updateTable("_emdash_media_usage_activation")
		.set({ state: "active", activated_at: "2026-08-05T00:00:00.000Z" })
		.execute();

	return {
		collectionId: collection.id,
		collectionSlug,
		tableName: `ec_${collectionSlug}`,
	};
}

async function createActiveLocalizedFixture() {
	const collectionSlug = "localized_measured";
	const registry = new SchemaRegistry(db);
	await registry.createCollection({
		slug: collectionSlug,
		label: "Localized measured",
		supports: [],
	});
	await registry.createField(collectionSlug, { slug: "title", label: "Title", type: "string" });
	await registry.createField(collectionSlug, {
		slug: "shared_body",
		label: "Shared body",
		type: "portableText",
		translatable: false,
	});
	const collection = await registry.getCollection(collectionSlug);
	if (!collection) throw new Error("Expected localized measured collection");

	await db
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
	await installMediaUsageCaptureTriggers(db, {
		collectionId: collection.id,
		collectionSlug,
	});
	await db
		.updateTable("_emdash_media_usage_index_status")
		.set({ capture_state: "active" })
		.where("collection_id", "=", collection.id)
		.execute();

	return { collectionId: collection.id, collectionSlug };
}

async function insertEntry(contentId: string, data: ReturnType<typeof mediaData>): Promise<void> {
	await sql`
		INSERT INTO ${sql.ref(fixture.tableName)} (id, slug, status, title, body, sections)
		VALUES (
			${contentId},
			${contentId},
			'published',
			${contentId},
			${JSON.stringify(data.body)},
			${JSON.stringify(data.sections)}
		)
	`.execute(db);
}

async function updateEntry(contentId: string, data: ReturnType<typeof mediaData>): Promise<void> {
	await sql`
		UPDATE ${sql.ref(fixture.tableName)}
		SET body = ${JSON.stringify(data.body)}, sections = ${JSON.stringify(data.sections)}
		WHERE id = ${contentId}
	`.execute(db);
}

async function addDraft(contentId: string, data: ReturnType<typeof mediaData>): Promise<void> {
	const revisionId = `revision-${contentId}`;
	await db
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
	`.execute(db);
}

async function updateDraft(contentId: string, data: ReturnType<typeof mediaData>): Promise<void> {
	await db
		.updateTable("revisions")
		.set({ data: JSON.stringify(data) })
		.where("id", "=", `revision-${contentId}`)
		.execute();
	await sql`
		UPDATE ${sql.ref(fixture.tableName)}
		SET title = title
		WHERE id = ${contentId}
	`.execute(db);
}

async function insertOperatorWork(
	contentId: string,
	state: "pending" | "retry" | "leased" | "failed",
	updatedAt: string,
): Promise<void> {
	await db
		.insertInto("_emdash_media_usage_work")
		.values({
			collection_id: fixture.collectionId,
			collection_slug: fixture.collectionSlug,
			content_id: contentId,
			change_epoch: 0,
			work_version: 1,
			state,
			attempt_count: 0,
			next_attempt_at: "2000-01-01T00:00:00.000Z",
			lease_token: state === "leased" ? `lease-${contentId}` : null,
			lease_expires_at: state === "leased" ? "2100-01-01T00:00:00.000Z" : null,
			last_attempted_at: null,
			last_error_code: state === "failed" ? "MEDIA_USAGE_PROCESSING_FAILED" : null,
			created_at: updatedAt,
			updated_at: updatedAt,
		})
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

async function installGenerationConflictTrigger(): Promise<void> {
	await sql`
		CREATE TRIGGER measure_generation_conflict
		AFTER INSERT ON _emdash_media_usage_generation_writes
		BEGIN
			UPDATE _emdash_media_usage_sources
			SET updated_at = updated_at || 'x'
			WHERE content_id = 'path-conflict';
		END
	`.execute(db);
}

async function installAnySourceConflictTrigger(): Promise<void> {
	await sql`
		CREATE TRIGGER measure_any_generation_conflict
		AFTER INSERT ON _emdash_media_usage_generation_writes
		BEGIN
			UPDATE _emdash_media_usage_sources
			SET updated_at = updated_at || 'x'
			WHERE source_key = NEW.source_key;
		END
	`.execute(db);
}

async function installDraftSourceConflictTrigger(): Promise<void> {
	await sql`
		CREATE TRIGGER measure_draft_generation_conflict
		AFTER INSERT ON _emdash_media_usage_generation_writes
		WHEN NEW.source_key LIKE '%:draft_overlay'
		BEGIN
			UPDATE _emdash_media_usage_sources
			SET updated_at = updated_at || 'x'
			WHERE source_key = NEW.source_key;
		END
	`.execute(db);
}

async function measure<T>(
	operation: () => Promise<T>,
): Promise<{ value: T; measurement: Measurement; queries: CapturedQuery[] }> {
	captured = [];
	const beforeChanges = totalChanges();
	const startedAt = performance.now();
	const value = await operation();
	const durationMs = performance.now() - startedAt;
	return {
		value,
		queries: [...captured],
		measurement: {
			statements: captured.length,
			d1EquivalentStatements: captured.filter(
				(query) => !/^(?:begin|commit|rollback)$/i.test(query.sql),
			).length,
			maxBinds: Math.max(0, ...captured.map((query) => query.parameters.length)),
			changedRows: totalChanges() - beforeChanges,
			durationMs: Number(durationMs.toFixed(3)),
		},
	};
}

function totalChanges(): number {
	return (sqlite.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
}

function expectOperatorPlans(queries: CapturedQuery[], expectedCount: number): void {
	const listQueries = queries.filter((query) =>
		query.sql.includes('from "_emdash_media_usage_work" as "work"'),
	);
	expect(listQueries).toHaveLength(expectedCount);
	for (const query of listQueries) {
		const plan = explain(query);
		expect(plan).toContain("idx__emdash_media_usage_work_operator");
		expect(plan).not.toContain("USE TEMP B-TREE");
		expect(plan).not.toContain("SCAN work");
	}
}

function explain(query: CapturedQuery): string {
	const rows = sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
		.all(...query.parameters.map(bindable)) as { detail: string }[];
	return rows.map((row) => row.detail).join("\n");
}

function bindable(parameter: unknown): unknown {
	if (typeof parameter === "boolean") return parameter ? 1 : 0;
	if (parameter instanceof Date) return parameter.toISOString();
	if (parameter === undefined) return null;
	return parameter;
}
