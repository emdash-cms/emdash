import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	formatDatetimeStorageReport,
	normalizeDatetimeStorage,
	scanDatetimeStorage,
} from "../../../src/database/datetime-storage.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
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

interface StatementHooks {
	before?: (statement: string, index: number) => void;
	after?: (statement: string, index: number) => Promise<void> | void;
}

/** Records every statement and bound value sent through the returned handle and runs the hooks around it. */
function instrument(db: Kysely<Database>, hooks: StatementHooks = {}) {
	const statements: string[] = [];
	const parameters: unknown[] = [];
	const indexes = new Map<unknown, number>();
	const instrumented = db.withPlugin({
		transformQuery(args) {
			const compiled = db.getExecutor().compileQuery(args.node, args.queryId);
			statements.push(compiled.sql);
			parameters.push(...compiled.parameters);
			indexes.set(args.queryId, statements.length);
			hooks.before?.(statements.at(-1)!, statements.length);
			return args.node;
		},
		async transformResult(args) {
			const index = indexes.get(args.queryId)!;
			await hooks.after?.(statements[index - 1]!, index);
			return args.result;
		},
	});
	return { db: instrumented, statements, parameters };
}

/** Fails statement `at` before it runs, or after it ran with its response lost. */
function interruptAt(db: Kysely<Database>, at: number, applied: boolean) {
	return instrument(db, {
		before: (_statement, index) => {
			if (!applied && index === at) throw new Error("interrupted");
		},
		after: (_statement, index) => {
			if (applied && index === at) throw new Error("interrupted");
		},
	}).db;
}

function readsFrom(statements: readonly string[], table: string): number {
	const pattern = new RegExp(`^\\s*select\\b[\\s\\S]*\\bfrom "${table}"`, "i");
	return statements.filter((statement) => pattern.test(statement)).length;
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

	interface EventRow {
		id: string;
		startsAt: string;
		beginsAt: string;
		publishedAt?: string | null;
	}

	async function insertEvents(rows: readonly EventRow[]) {
		for (let offset = 0; offset < rows.length; offset += 20) {
			const values = rows.slice(offset, offset + 20).map(
				(row) => sql`(
					${row.id}, ${row.id}, 'draft', ${CREATED_AT}, ${CREATED_AT}, ${row.publishedAt ?? null},
					1, 'en', ${row.id}, ${row.startsAt}, ${JSON.stringify([{ begins_at: row.beginsAt }])}
				)`,
			);
			await sql`
				INSERT INTO ec_events (
					id, slug, status, created_at, updated_at, published_at, version, locale,
					translation_group, starts_at, sessions
				) VALUES ${sql.join(values)}
			`.execute(ctx.db);
		}
	}

	async function insertRevisions(rows: readonly { id: string; entryId: string; data: unknown }[]) {
		for (let offset = 0; offset < rows.length; offset += 20) {
			await ctx.db
				.insertInto("revisions")
				.values(
					rows.slice(offset, offset + 20).map((row) => ({
						id: row.id,
						collection: "events",
						entry_id: row.entryId,
						data: JSON.stringify(row.data),
						author_id: null,
						created_at: CREATED_AT,
					})),
				)
				.execute();
		}
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

	it("logs the report as info only when values are rewritten", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			await insertEvent("event-clean", "2026-08-21T16:00:00.000Z", "2026-01-15T15:00:00.000Z");
			await normalizeDatetimeStorage(ctx.db);
			expect(info).not.toHaveBeenCalled();
			expect(error).not.toHaveBeenCalled();

			await insertEvent("event-naive", "2026-01-15T09:30", "2026-01-15T15:00:00.000Z");
			await normalizeDatetimeStorage(ctx.db);
			expect(info).toHaveBeenCalledWith(expect.stringContaining("1 noncanonical values (1 naive)"));
			expect(error).not.toHaveBeenCalled();
		} finally {
			error.mockRestore();
			info.mockRestore();
		}
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

	it("writes changed rows in far fewer statements than rows", async () => {
		const count = 1_000;
		const ids = Array.from(
			{ length: count },
			(_, index) => `event-${String(index).padStart(4, "0")}`,
		);
		await insertEvents(
			ids.map((id) => ({
				id,
				startsAt: "2026-01-15T09:30",
				beginsAt: "2026-01-15T10:00",
				publishedAt: "2026-08-22T01:00:00+09:00",
			})),
		);
		await insertRevisions(
			ids.map((id) => ({
				id: `revision-${id}`,
				entryId: id,
				data: { starts_at: "2026-01-15T09:30", sessions: [{ begins_at: "2026-01-15T10:00" }] },
			})),
		);
		const recorded = instrument(ctx.db);

		await normalizeDatetimeStorage(recorded.db);

		const writes = recorded.statements.filter((statement) =>
			/^\s*(?:with\b[\s\S]*\)\s*)?update\b/i.test(statement),
		);
		expect(writes.length).toBeGreaterThan(0);
		expect(writes.length * 20).toBeLessThan(count * 2);
		await expect(scanDatetimeStorage(ctx.db)).resolves.toMatchObject({ noncanonicalCount: 0 });
		const content = await sql<{ starts_at: string; published_at: string; sessions: unknown }>`
			SELECT starts_at, published_at, sessions FROM ec_events WHERE id = ${ids.at(-1)!}
		`.execute(ctx.db);
		expect(content.rows[0]).toMatchObject({
			starts_at: "2026-01-15T14:30:00.000Z",
			published_at: "2026-08-21T16:00:00.000Z",
		});
		expect(parseJsonValue(content.rows[0]!.sessions)).toEqual([
			{ begins_at: "2026-01-15T15:00:00.000Z" },
		]);
		const revision = await ctx.db
			.selectFrom("revisions")
			.select("data")
			.where("id", "=", `revision-${ids[0]!}`)
			.executeTakeFirstOrThrow();
		expect(JSON.parse(revision.data)).toEqual({
			starts_at: "2026-01-15T14:30:00.000Z",
			sessions: [{ begins_at: "2026-01-15T15:00:00.000Z" }],
		});
	});

	it("normalizes large revisions without binding a value over D1's 2,000,000-byte limit", async () => {
		await insertEvent("event-1", "2026-01-15T09:30");
		const sizes = { a: 1_100_000, b: 600_000, c: 600_000, d: 0 };
		await insertRevisions(
			Object.entries(sizes).map(([suffix, size]) => ({
				id: `revision-${suffix}`,
				entryId: "event-1",
				data: { starts_at: "2026-01-15T09:30", body: suffix.repeat(size) },
			})),
		);
		const recorded = instrument(ctx.db);

		await normalizeDatetimeStorage(recorded.db);

		const encoder = new TextEncoder();
		const boundBytes = recorded.parameters.map((value) =>
			typeof value === "string" ? encoder.encode(value).byteLength : 0,
		);
		expect(Math.max(...boundBytes)).toBeLessThanOrEqual(2_000_000);
		const revisions = await ctx.db
			.selectFrom("revisions")
			.select(["id", "data"])
			.orderBy("id")
			.execute();
		expect(
			revisions.map((row) => {
				const data = JSON.parse(row.data) as { starts_at: string; body: string };
				return [row.id, data.starts_at, data.body.length];
			}),
		).toEqual(
			Object.entries(sizes).map(([suffix, size]) => [
				`revision-${suffix}`,
				"2026-01-15T14:30:00.000Z",
				size,
			]),
		);
	});

	it("fails when a row or revision gets a naive value behind the write pass, and a rerun normalizes it", async () => {
		await insertEvent("event-1", "2026-01-15T09:30");
		await insertEvent("event-2", "2026-01-15T09:30");
		await insertRevisions(
			["event-1", "event-2"].map((entryId) => ({
				id: `revision-${entryId}`,
				entryId,
				data: { starts_at: "2026-01-15T09:30" },
			})),
		);
		const reads = { ec_events: 0, revisions: 0 };
		const racing = instrument(ctx.db, {
			after: async (statement) => {
				if (readsFrom([statement], "ec_events") > 0 && ++reads.ec_events === 2) {
					await sql`UPDATE ec_events SET starts_at = '2026-02-01T08:00' WHERE id = 'event-2'`.execute(
						ctx.db,
					);
				}
				if (readsFrom([statement], "revisions") > 0 && ++reads.revisions === 2) {
					await ctx.db
						.updateTable("revisions")
						.set({ data: JSON.stringify({ starts_at: "2026-02-01T08:00" }) })
						.where("id", "=", "revision-event-2")
						.execute();
				}
			},
		});

		await expect(normalizeDatetimeStorage(racing.db)).rejects.toThrow(
			"did not reach a canonical state",
		);
		await normalizeDatetimeStorage(ctx.db);

		const rows = await sql<{ id: string; starts_at: string }>`
			SELECT id, starts_at FROM ec_events ORDER BY id
		`.execute(ctx.db);
		expect(rows.rows).toEqual([
			{ id: "event-1", starts_at: "2026-01-15T14:30:00.000Z" },
			{ id: "event-2", starts_at: "2026-02-01T13:00:00.000Z" },
		]);
		const revisions = await ctx.db
			.selectFrom("revisions")
			.select(["id", "data"])
			.orderBy("id")
			.execute();
		expect(revisions.map((row) => [row.id, JSON.parse(row.data)])).toEqual([
			["revision-event-1", { starts_at: "2026-01-15T14:30:00.000Z" }],
			["revision-event-2", { starts_at: "2026-02-01T13:00:00.000Z" }],
		]);
	});

	describe("after an interrupted run", () => {
		beforeEach(async () => {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "notes", label: "Notes", labelSingular: "Note" });
			await registry.createField("notes", { slug: "due_at", label: "Due at", type: "datetime" });
		});

		async function seed() {
			await sql`DELETE FROM ec_events`.execute(ctx.db);
			await sql`DELETE FROM ec_notes`.execute(ctx.db);
			await ctx.db.deleteFrom("revisions").execute();
			await ctx.db.deleteFrom("options").where("name", "!=", "site:timezone").execute();
			const starts = ["2026-01-15T09:30", "2026-08-22T01:00:00+09:00", "2026-03-01T12:00:00.000Z"];
			const eventIds = Array.from(
				{ length: 60 },
				(_, index) => `event-${String(index).padStart(2, "0")}`,
			);
			await insertEvents(
				eventIds.map((id, index) => ({
					id,
					startsAt: starts[index % starts.length]!,
					beginsAt: index % 2 === 0 ? "2026-01-15T10:00" : "2026-01-15T15:00:00.000Z",
					publishedAt: index % 4 === 0 ? null : "2026-05-05T05:05",
				})),
			);
			for (let offset = 0; offset < 55; offset += 20) {
				const values = Array.from({ length: Math.min(20, 55 - offset) }, (_, step) => {
					const id = `note-${String(offset + step).padStart(2, "0")}`;
					return sql`(${id}, ${id}, 'draft', ${CREATED_AT}, ${CREATED_AT}, 1, 'en', ${id}, '2026-07-04T18:00')`;
				});
				await sql`
					INSERT INTO ec_notes (
						id, slug, status, created_at, updated_at, version, locale, translation_group, due_at
					) VALUES ${sql.join(values)}
				`.execute(ctx.db);
			}
			await insertRevisions(
				eventIds.map((id, index) => ({
					id: `revision-${id}`,
					entryId: id,
					data: {
						starts_at: starts[index % starts.length],
						sessions: [{ begins_at: "2026-01-15T10:00" }],
					},
				})),
			);
		}

		async function snapshot() {
			const events = await sql<Record<string, unknown>>`
				SELECT id, created_at, updated_at, published_at, starts_at, sessions FROM ec_events ORDER BY id
			`.execute(ctx.db);
			const notes = await sql<Record<string, unknown>>`
				SELECT id, due_at FROM ec_notes ORDER BY id
			`.execute(ctx.db);
			return {
				events: events.rows.map((row) => ({ ...row, sessions: parseJsonValue(row.sessions) })),
				notes: notes.rows,
				revisions: await ctx.db
					.selectFrom("revisions")
					.select(["id", "data"])
					.orderBy("id")
					.execute(),
				options: await ctx.db
					.selectFrom("options")
					.select(["name", "value"])
					.orderBy("name")
					.execute(),
			};
		}

		it(
			"reaches the same data when stopped at any statement and run again",
			{ timeout: 120_000 },
			async () => {
				await seed();
				const clean = instrument(ctx.db);
				await normalizeDatetimeStorage(clean.db);
				const expected = await snapshot();
				expect(expected.notes[0]).toEqual({ id: "note-00", due_at: "2026-07-04T22:00:00.000Z" });
				expect(expected.events.slice(1, 3)).toEqual([
					{
						id: "event-01",
						created_at: CREATED_AT,
						updated_at: CREATED_AT,
						published_at: "2026-05-05T09:05:00.000Z",
						starts_at: "2026-08-21T16:00:00.000Z",
						sessions: [{ begins_at: "2026-01-15T15:00:00.000Z" }],
					},
					{
						id: "event-02",
						created_at: CREATED_AT,
						updated_at: CREATED_AT,
						published_at: "2026-05-05T09:05:00.000Z",
						starts_at: "2026-03-01T12:00:00.000Z",
						sessions: [{ begins_at: "2026-01-15T15:00:00.000Z" }],
					},
				]);

				for (let at = 1; at <= clean.statements.length; at++) {
					for (const applied of [false, true]) {
						await seed();
						await expect(
							normalizeDatetimeStorage(interruptAt(ctx.db, at, applied)),
							`stopped at statement ${at} (${applied ? "applied" : "not applied"})`,
						).rejects.toThrow("interrupted");
						await normalizeDatetimeStorage(ctx.db);
						expect(await snapshot(), `stopped at statement ${at}`).toEqual(expected);
					}
				}
			},
		);

		it.each([
			{
				table: "ec_events",
				write: /\bupdate "ec_events"/i,
				reads: { ec_events: 3, ec_notes: 4, revisions: 4 },
			},
			{
				table: "revisions",
				write: /\bupdate "?revisions"?\b/i,
				reads: { ec_events: 2, ec_notes: 2, revisions: 3 },
			},
		])(
			"resumes after the last written page of $table without another preflight",
			async ({ write, reads }) => {
				await seed();
				const clean = instrument(ctx.db);
				await normalizeDatetimeStorage(clean.db);
				const secondWrite =
					clean.statements.findIndex(
						(statement, index) =>
							write.test(statement) &&
							clean.statements.slice(0, index).some((earlier) => write.test(earlier)),
					) + 1;
				expect(secondWrite).toBeGreaterThan(0);
				await seed();
				await expect(
					normalizeDatetimeStorage(interruptAt(ctx.db, secondWrite, false)),
				).rejects.toThrow("interrupted");

				const resumed = instrument(ctx.db);
				await normalizeDatetimeStorage(resumed.db);

				expect({
					ec_events: readsFrom(resumed.statements, "ec_events"),
					ec_notes: readsFrom(resumed.statements, "ec_notes"),
					revisions: readsFrom(resumed.statements, "revisions"),
				}).toEqual(reads);
			},
		);

		it("does not read a finished table again when its last pages needed no writes", async () => {
			await seed();
			await insertEvents(
				Array.from({ length: 50 }, (_, index) => ({
					id: `event-zz-${String(index).padStart(2, "0")}`,
					startsAt: "2026-03-01T12:00:00.000Z",
					beginsAt: "2026-01-15T15:00:00.000Z",
				})),
			);
			const clean = instrument(ctx.db);
			await normalizeDatetimeStorage(clean.db);
			const firstNotesWrite =
				clean.statements.findIndex((statement) => /\bupdate "ec_notes"/i.test(statement)) + 1;
			expect(firstNotesWrite).toBeGreaterThan(0);
			await seed();
			await insertEvents(
				Array.from({ length: 50 }, (_, index) => ({
					id: `event-zz-${String(index).padStart(2, "0")}`,
					startsAt: "2026-03-01T12:00:00.000Z",
					beginsAt: "2026-01-15T15:00:00.000Z",
				})),
			);
			await expect(
				normalizeDatetimeStorage(interruptAt(ctx.db, firstNotesWrite, false)),
			).rejects.toThrow("interrupted");

			const resumed = instrument(ctx.db);
			await normalizeDatetimeStorage(resumed.db);

			expect(readsFrom(resumed.statements, "ec_events")).toBe(3);
		});

		it("removes a resume point it cannot use when nothing is left to normalize", async () => {
			await seed();
			const clean = instrument(ctx.db);
			await normalizeDatetimeStorage(clean.db);
			const expected = await snapshot();
			await seed();
			await expect(
				normalizeDatetimeStorage(interruptAt(ctx.db, clean.statements.length, false)),
			).rejects.toThrow("interrupted");
			await new OptionsRepository(ctx.db).set("site:timezone", "Europe/Berlin");

			await normalizeDatetimeStorage(ctx.db);
			await new OptionsRepository(ctx.db).set("site:timezone", "America/New_York");

			expect(await snapshot()).toEqual(expected);
		});

		it("starts over with a preflight when the site timezone changed since the interrupted run", async () => {
			await seed();
			const clean = instrument(ctx.db);
			await normalizeDatetimeStorage(clean.db);
			const firstEventsWrite =
				clean.statements.findIndex((statement) => /\bupdate "ec_events"/i.test(statement)) + 1;
			await seed();
			await expect(
				normalizeDatetimeStorage(interruptAt(ctx.db, firstEventsWrite, false)),
			).rejects.toThrow("interrupted");
			await new OptionsRepository(ctx.db).set("site:timezone", "Europe/Berlin");

			const rerun = instrument(ctx.db);
			await normalizeDatetimeStorage(rerun.db);

			expect(readsFrom(rerun.statements, "ec_notes")).toBe(6);
			const note = await sql<{ due_at: string }>`
				SELECT due_at FROM ec_notes WHERE id = 'note-00'
			`.execute(ctx.db);
			expect(note.rows[0]?.due_at).toBe("2026-07-04T16:00:00.000Z");
		});
	});
});
