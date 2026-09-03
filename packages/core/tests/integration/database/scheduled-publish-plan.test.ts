/**
 * Query-plan coverage for the scheduled-publishing sweep.
 *
 * SQLite runs without ANALYZE/sqlite_stat1 here, matching D1's stats-blind
 * planner. Publish behaviour for due content is covered by the
 * scheduled-publish suite.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import * as migration074 from "../../../src/database/migrations/074_content_deleted_scheduled_index.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database as DatabaseSchema } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

interface CapturedQuery {
	sql: string;
	parameters: readonly unknown[];
}

let sqlite: Database.Database;
let db: Kysely<DatabaseSchema>;
let repo: ContentRepository;
let captured: CapturedQuery[];

beforeEach(async () => {
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
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
	repo = new ContentRepository(db);

	seedLiveRows(2000);
	captured = [];
});

afterEach(async () => {
	await db.destroy();
});

it("seeks due content through the scheduled index instead of scanning live rows", async () => {
	const due = await repo.findReadyToPublish("post", 100);

	expect(due).toEqual([]);

	const plan = explain(scheduledQuery());
	expect(contentAccess(plan)).toMatch(
		/SEARCH ec_post USING (?:COVERING )?INDEX idx_ec_post_del_sched \(deleted_at=\? AND scheduled_at/,
	);
	expect(plan).not.toContain("SCAN ec_post");
	expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
});

it("still returns due content oldest-first, skipping soft-deleted rows", async () => {
	insertRow("due-late", { scheduledAt: "2025-06-02T00:00:00.000Z" });
	insertRow("due-early", { scheduledAt: "2025-06-01T00:00:00.000Z" });
	insertRow("due-deleted", {
		scheduledAt: "2025-05-01T00:00:00.000Z",
		deletedAt: "2025-05-02T00:00:00.000Z",
	});
	insertRow("not-yet-due", { scheduledAt: "2099-01-01T00:00:00.000Z" });

	const due = await repo.findReadyToPublish("post", 100);

	expect(due.map((item) => item.id)).toEqual(["due-early", "due-late"]);
});

it("migrates a pre-074 table off the deleted_at-leading plan", async () => {
	sqlite.exec(`DROP INDEX idx_ec_post_del_sched`);
	sqlite.exec(
		`CREATE INDEX idx_ec_post_scheduled ON ec_post (scheduled_at) WHERE scheduled_at IS NOT NULL`,
	);
	captured = [];
	await repo.findReadyToPublish("post", 100);
	const before = explain(scheduledQuery());
	expect(contentAccess(before)).toMatch(/SEARCH ec_post USING INDEX \S+ \(deleted_at=\?\)/);
	expect(before).toContain("USE TEMP B-TREE FOR ORDER BY");

	await migration074.up(db);

	expect(indexNames()).not.toContain("idx_ec_post_scheduled");
	captured = [];
	await repo.findReadyToPublish("post", 100);
	const after = explain(scheduledQuery());
	expect(contentAccess(after)).toMatch(
		/SEARCH ec_post USING (?:COVERING )?INDEX idx_ec_post_del_sched \(deleted_at=\? AND scheduled_at/,
	);
	expect(after).not.toContain("USE TEMP B-TREE FOR ORDER BY");
});

function seedLiveRows(count: number): void {
	const insert = sqlite.prepare(
		`INSERT INTO ec_post (id, slug, status, locale, created_at, updated_at, version)
		 VALUES (?, ?, 'published', 'en', '2025-01-01', '2025-01-01', 1)`,
	);
	for (let index = 1; index <= count; index++) {
		insert.run(`live-${index}`, `live-${index}`);
	}
}

function insertRow(
	id: string,
	{ scheduledAt, deletedAt = null }: { scheduledAt: string; deletedAt?: string | null },
): void {
	sqlite
		.prepare(
			`INSERT INTO ec_post (id, slug, status, locale, created_at, updated_at, version, scheduled_at, deleted_at)
			 VALUES (?, ?, 'scheduled', 'en', '2025-01-01', '2025-01-01', 1, ?, ?)`,
		)
		.run(id, id, scheduledAt, deletedAt);
}

function indexNames(): string[] {
	return (
		sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as {
			name: string;
		}[]
	).map((row) => row.name);
}

function scheduledQuery(): CapturedQuery {
	const queries = captured.filter((query) => query.sql.includes("scheduled_at <="));
	expect(queries).toHaveLength(1);
	return queries[0]!;
}

/** better-sqlite3 only binds primitives; coerce values captured from Kysely. */
function bindable(parameter: unknown): unknown {
	if (typeof parameter === "boolean") return parameter ? 1 : 0;
	if (parameter instanceof Date) return parameter.toISOString();
	if (parameter === undefined) return null;
	return parameter;
}

function explain(query: CapturedQuery): string {
	const rows = sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
		.all(...query.parameters.map(bindable)) as { detail: string }[];
	return rows.map((row) => row.detail).join("\n");
}

function contentAccess(plan: string): string | undefined {
	return plan.split("\n").find((detail) => /\b(?:SCAN|SEARCH) ec_post\b/.test(detail));
}
