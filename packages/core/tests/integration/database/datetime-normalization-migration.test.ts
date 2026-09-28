import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	formatDatetimeStorageReport,
	normalizeDatetimeStorage,
	scanDatetimeStorage,
} from "../../../src/database/datetime-storage.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

function parseJsonValue(value: unknown): unknown {
	return typeof value === "string" ? JSON.parse(value) : value;
}

describeEachDialect("datetime normalization migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({
			slug: "events",
			label: "Events",
			labelSingular: "Event",
			supports: ["revisions"],
		});
		await registry.createField("events", {
			slug: "starts_at",
			label: "Starts at",
			type: "datetime",
			indexed: true,
		});
		await registry.createField("events", {
			slug: "sessions",
			label: "Sessions",
			type: "repeater",
			validation: {
				subFields: [{ slug: "begins_at", label: "Begins at", type: "datetime" }],
			},
		});
		await new OptionsRepository(ctx.db).set("site:timezone", "America/New_York");
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function insertEvent(id: string, startsAt: string, beginsAt = "2026-01-15T10:00") {
		await sql`
			INSERT INTO ec_events (
				id, slug, status, created_at, updated_at, version, locale, translation_group,
				starts_at, sessions
			) VALUES (
				${id}, ${id}, 'draft', ${CREATED_AT}, ${CREATED_AT}, 1, 'en', ${id},
				${startsAt}, ${JSON.stringify([{ begins_at: beginsAt }])}
			)
		`.execute(ctx.db);
	}

	it("detects, reports, and normalizes content plus revision JSON idempotently", async () => {
		await insertEvent("event-1", "2026-08-22T01:00:00+09:00");
		await ctx.db
			.insertInto("revisions")
			.values({
				id: "revision-1",
				collection: "events",
				entry_id: "event-1",
				data: JSON.stringify({
					starts_at: "2026-08-22T01:00:00+09:00",
					sessions: [{ begins_at: "2026-01-15T10:00" }],
				}),
				author_id: null,
				created_at: CREATED_AT,
			})
			.execute();

		const detected = await scanDatetimeStorage(ctx.db);
		expect(detected).toMatchObject({
			timezone: "America/New_York",
			noncanonicalCount: 4,
			naiveCount: 2,
			manualReviewCount: 0,
			inspectionErrorCount: 0,
		});
		expect(formatDatetimeStorageReport(detected)).toContain("4 noncanonical values (2 naive)");

		await normalizeDatetimeStorage(ctx.db);
		await expect(normalizeDatetimeStorage(ctx.db)).resolves.toMatchObject({ noncanonicalCount: 0 });

		const content = await sql<{ starts_at: string; sessions: unknown }>`
			SELECT starts_at, sessions FROM ec_events WHERE id = 'event-1'
		`.execute(ctx.db);
		expect(content.rows[0]?.starts_at).toBe("2026-08-21T16:00:00.000Z");
		expect(parseJsonValue(content.rows[0]!.sessions)).toEqual([
			{ begins_at: "2026-01-15T15:00:00.000Z" },
		]);
		const revision = await ctx.db
			.selectFrom("revisions")
			.select("data")
			.where("id", "=", "revision-1")
			.executeTakeFirstOrThrow();
		expect(JSON.parse(revision.data)).toEqual({
			starts_at: "2026-08-21T16:00:00.000Z",
			sessions: [{ begins_at: "2026-01-15T15:00:00.000Z" }],
		});
	});

	it("processes more than one bounded page", async () => {
		for (let index = 0; index < 55; index++) {
			await insertEvent(`event-${String(index).padStart(2, "0")}`, "2026-01-15T09:30");
		}

		await normalizeDatetimeStorage(ctx.db);

		const rows = await sql<{ starts_at: string }>`SELECT starts_at FROM ec_events`.execute(ctx.db);
		expect(rows.rows).toHaveLength(55);
		expect(new Set(rows.rows.map((row) => row.starts_at))).toEqual(
			new Set(["2026-01-15T14:30:00.000Z"]),
		);
	});

	describe.each([
		["ambiguous", "2026-11-01T01:30"],
		["nonexistent", "2026-03-08T02:30"],
	] as const)("%s site-local value", (_kind, localValue) => {
		it("requires manual review before writing any rows", async () => {
			await insertEvent("event-safe", "2026-08-22T01:00:00+09:00");
			await insertEvent("event-review", localValue);

			await expect(normalizeDatetimeStorage(ctx.db)).rejects.toThrow("requires manual review");

			const safe = await sql<{ starts_at: string }>`
				SELECT starts_at FROM ec_events WHERE id = 'event-safe'
			`.execute(ctx.db);
			expect(safe.rows[0]?.starts_at).toBe("2026-08-22T01:00:00+09:00");
			const report = await scanDatetimeStorage(ctx.db);
			expect(report.manualReviewCount).toBe(1);
			expect(report.samples).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ location: `ec_events/event-review.starts_at` }),
				]),
			);
		});
	});
});
