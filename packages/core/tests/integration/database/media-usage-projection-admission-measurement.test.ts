import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock(
	"virtual:emdash/object-cache",
	() => ({ createObjectCache: undefined, objectCacheConfig: {} }),
	{ virtual: true },
);

import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as DatabaseSchema } from "../../../src/database/types.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { buildContentMediaUsageSourceKey } from "../../../src/media/usage/source-key.js";
import { processMediaUsageWorkAfterWrite } from "../../../src/media/usage/work-processor.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	addMediaUsageMeasurementDraft,
	createMediaUsageAdmissionFixture,
	insertMediaUsageMeasurementEntry,
	mediaUsageMeasurementData as mediaData,
} from "../../utils/media-usage-admission-fixture.js";

interface CapturedQuery {
	sql: string;
	parameters: readonly unknown[];
}

interface Measurement {
	d1Queries: number;
	maxBinds: number;
	maxSqlBytes: number;
	changedRows: number;
	durationMs: number;
}

interface MeasurementRow extends Measurement {
	path: "processor" | "processor-bytes" | "runtime-conflict" | "runtime-create" | "runtime-update";
	totalOccurrences: number;
	liveOccurrences: number;
	draftOccurrences: number | null;
	outcome: string;
	payloadBytes?: number;
}

let sqlite: Database.Database;
let db: Kysely<DatabaseSchema>;
let captured: CapturedQuery[];
let fixture: Awaited<ReturnType<typeof createActiveFixture>>;

beforeAll(async () => {
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

afterAll(async () => {
	setI18nConfig(null);
	await db.destroy();
});

it("reports current projection costs at occurrence and byte boundaries", async () => {
	const rows: MeasurementRow[] = [];
	for (const totalOccurrences of [0, 1, 3, 4, 6, 9, 12, 15, 18, 21, 24, 27, 30]) {
		for (const [liveOccurrences, draftOccurrences] of candidateSplits(totalOccurrences)) {
			const contentId = `processor-${totalOccurrences}-${liveOccurrences}-${draftOccurrences ?? "none"}`;
			await insertEntry(contentId, mediaData(liveOccurrences, `${contentId}-live`));
			if (draftOccurrences !== null) {
				await addDraft(contentId, mediaData(draftOccurrences, `${contentId}-draft`));
			}

			const result = await measure(() =>
				processMediaUsageWorkAfterWrite(db, fixture.collectionSlug, contentId),
			);
			const expectedOutcome = totalOccurrences <= 12 ? "completed" : "failed";
			expect(result.value.outcome).toBe(expectedOutcome);
			rows.push({
				path: "processor",
				totalOccurrences,
				liveOccurrences,
				draftOccurrences,
				outcome: result.value.outcome,
				...result.measurement,
			});
		}
	}
	for (const payloadBytes of [64, 128, 256, 512, 768, 1024].map((size) => size * 1024)) {
		const contentId = `bytes-${payloadBytes}`;
		const title = "é".repeat(payloadBytes / 2);
		await insertEntry(contentId, mediaData(0, contentId), title);
		const result = await measure(() =>
			processMediaUsageWorkAfterWrite(db, fixture.collectionSlug, contentId),
		);
		const expectedOutcome = payloadBytes < 512 * 1024 ? "completed" : "failed";
		expect(result.value.outcome).toBe(expectedOutcome);
		rows.push({
			path: "processor-bytes",
			totalOccurrences: 0,
			liveOccurrences: 0,
			draftOccurrences: null,
			payloadBytes,
			outcome: result.value.outcome,
			...result.measurement,
		});
	}

	const runtime = createTestRuntime(db);
	for (const totalOccurrences of [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30]) {
		const createSlug = `runtime-create-${totalOccurrences}`;
		const created = await measure(() =>
			runtime.handleContentCreate(fixture.collectionSlug, {
				slug: createSlug,
				data: { title: createSlug, ...mediaData(totalOccurrences, createSlug) },
			}),
		);
		expect(created.value.success).toBe(true);
		if (!created.value.success) throw new Error(created.value.error.message);
		const createOutcome = await workOutcome(created.value.data.item.id);
		expect(createOutcome).toBe(totalOccurrences <= 12 ? "completed" : "failed");
		rows.push({
			path: "runtime-create",
			totalOccurrences,
			liveOccurrences: totalOccurrences,
			draftOccurrences: null,
			outcome: createOutcome,
			...created.measurement,
		});

		for (const [liveOccurrences, draftOccurrences] of candidateSplits(totalOccurrences)) {
			if (draftOccurrences === null) continue;
			const slug = `runtime-update-${totalOccurrences}-${liveOccurrences}-${draftOccurrences}`;
			const initial = await runtime.handleContentCreate(fixture.collectionSlug, {
				slug,
				data: { title: slug, ...mediaData(liveOccurrences, `${slug}-live`) },
			});
			expect(initial.success).toBe(true);
			if (!initial.success) throw new Error(initial.error.message);

			const updated = await measure(() =>
				runtime.handleContentUpdate(fixture.collectionSlug, initial.data.item.id, {
					data: mediaData(draftOccurrences, `${slug}-draft`),
				}),
			);
			expect(updated.value.success).toBe(true);
			const updateOutcome = await workOutcome(initial.data.item.id);
			expect(updateOutcome).toBe(
				liveOccurrences <= 12 && draftOccurrences <= 12 ? "completed" : "failed",
			);
			rows.push({
				path: "runtime-update",
				totalOccurrences,
				liveOccurrences,
				draftOccurrences,
				outcome: updateOutcome,
				...updated.measurement,
			});
		}
	}
	for (const draftOccurrences of [3, 6, 9, 12]) {
		const slug = `runtime-conflict-${draftOccurrences}`;
		const created = await runtime.handleContentCreate(fixture.collectionSlug, {
			slug,
			data: { title: slug, ...mediaData(0, `${slug}-live`) },
		});
		expect(created.success).toBe(true);
		if (!created.success) throw new Error(created.error.message);
		const initial = await runtime.handleContentUpdate(
			fixture.collectionSlug,
			created.data.item.id,
			{ data: mediaData(draftOccurrences, `${slug}-draft-initial`) },
		);
		expect(initial.success).toBe(true);

		const triggerName = `measure_admission_conflict_${draftOccurrences}`;
		const draftSourceKey = buildContentMediaUsageSourceKey({
			collectionId: fixture.collectionId,
			collectionSlug: fixture.collectionSlug,
			contentId: created.data.item.id,
			sourceVariant: "draft_overlay",
		});
		await sql`
			CREATE TRIGGER ${sql.ref(triggerName)}
			AFTER INSERT ON _emdash_media_usage_generation_writes
			WHEN NEW.source_key = ${sql.lit(draftSourceKey)}
			BEGIN
				UPDATE _emdash_media_usage_sources
				SET updated_at = updated_at || 'x'
				WHERE source_key = NEW.source_key;
			END
		`.execute(db);
		try {
			const result = await measure(() =>
				runtime.handleContentUpdate(fixture.collectionSlug, created.data.item.id, {
					data: mediaData(draftOccurrences, `${slug}-draft-changed`),
				}),
			);
			expect(result.value.success).toBe(true);
			const conflictOutcome = await workOutcome(created.data.item.id);
			expect(conflictOutcome).toBe("retry");
			rows.push({
				path: "runtime-conflict",
				totalOccurrences: draftOccurrences,
				liveOccurrences: 0,
				draftOccurrences,
				outcome: conflictOutcome,
				...result.measurement,
			});
		} finally {
			await sql`DROP TRIGGER ${sql.ref(triggerName)}`.execute(db);
		}
	}

	const worstByBoundary = new Map<string, MeasurementRow>();
	for (const row of rows) {
		const key =
			row.path === "processor-bytes"
				? `${row.path}:${row.payloadBytes}`
				: `${row.path}:${row.totalOccurrences}`;
		const current = worstByBoundary.get(key);
		if (!current || row.d1Queries > current.d1Queries) worstByBoundary.set(key, row);
	}
	console.info(`PR1_MEASUREMENTS=${JSON.stringify([...worstByBoundary.values()])}`);
	expect(rows.every((row) => row.maxBinds <= 100)).toBe(true);
});

function candidateSplits(totalOccurrences: number): Array<[number, number | null]> {
	const splits: Array<[number, number | null]> = [[totalOccurrences, null]];
	for (const liveOccurrences of [0, 1, 3, Math.floor(totalOccurrences / 2), totalOccurrences]) {
		if (liveOccurrences < 0 || liveOccurrences > totalOccurrences) continue;
		splits.push([liveOccurrences, totalOccurrences - liveOccurrences]);
	}
	return [...new Map(splits.map((split) => [split.join(":"), split])).values()];
}

async function createActiveFixture() {
	return createMediaUsageAdmissionFixture(db, "admission_measurement");
}

async function insertEntry(
	contentId: string,
	data: ReturnType<typeof mediaData>,
	title = contentId,
): Promise<void> {
	await insertMediaUsageMeasurementEntry(db, fixture, contentId, data, title);
}

async function addDraft(contentId: string, data: ReturnType<typeof mediaData>): Promise<void> {
	await addMediaUsageMeasurementDraft(db, fixture, contentId, data);
}

async function measure<T>(operation: () => Promise<T>): Promise<{
	value: T;
	measurement: Measurement;
}> {
	captured = [];
	const beforeChanges = totalChanges();
	const startedAt = performance.now();
	const value = await operation();
	await waitForDeferredTasks();
	return {
		value,
		measurement: {
			d1Queries: captured.filter((query) => !/^(?:begin|commit|rollback)$/i.test(query.sql.trim()))
				.length,
			maxBinds: Math.max(0, ...captured.map((query) => query.parameters.length)),
			maxSqlBytes: Math.max(0, ...captured.map((query) => Buffer.byteLength(query.sql))),
			changedRows: totalChanges() - beforeChanges,
			durationMs: Number((performance.now() - startedAt).toFixed(3)),
		},
	};
}

function totalChanges(): number {
	return (sqlite.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
}

async function workOutcome(contentId: string): Promise<string> {
	const work = await db
		.selectFrom("_emdash_media_usage_work")
		.select("state")
		.where("content_id", "=", contentId)
		.executeTakeFirst();
	return work?.state ?? "completed";
}
