/**
 * SQLite query-plan regression guard for the byline list behind `getBylines()`.
 * Output correctness is covered by unit/database/repositories/byline; this
 * asserts the planner enters `_emdash_bylines` on the locale index and reaches
 * the avatar's media row by primary key rather than scanning either table.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { runMigrations } from "../../src/database/migrations/runner.js";
import { BylineRepository } from "../../src/database/repositories/byline.js";
import type { Database as DatabaseSchema } from "../../src/database/types.js";

interface CapturedQuery {
	sql: string;
	parameters: readonly unknown[];
}

let sqlite: Database.Database;
let db: Kysely<DatabaseSchema>;
let captured: CapturedQuery[];
let repo: BylineRepository;

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

	// No ANALYZE: D1 never maintains sqlite_stat1.
	await runMigrations(db);
	repo = new BylineRepository(db);

	for (let i = 0; i < 30; i++) {
		await db
			.insertInto("media")
			.values({
				id: `media-${i}`,
				filename: `avatar-${i}.png`,
				mime_type: "image/png",
				storage_key: `avatar-${i}.png`,
				status: "ready",
			})
			.execute();
		await repo.create({
			slug: `author-${i}`,
			displayName: `Author ${i}`,
			avatarMediaId: `media-${i}`,
			locale: i % 2 === 0 ? "en" : "fr",
		});
	}
});

afterEach(async () => {
	await db.destroy();
});

/** better-sqlite3 only binds primitives; coerce the JS values Kysely captured. */
function bindable(p: unknown): unknown {
	if (typeof p === "boolean") return p ? 1 : 0;
	if (p instanceof Date) return p.toISOString();
	if (p === undefined) return null;
	return p;
}

function explain(query: CapturedQuery): string {
	const rows = sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
		.all(...query.parameters.map(bindable)) as { detail: string }[];
	return rows.map((r) => r.detail).join("\n");
}

async function listPlan(options: { locale?: string; cursor?: string; limit?: number }) {
	captured = [];
	const result = await repo.findManyAlphabetical(options);
	const query = captured.find((q) => q.sql.includes("_emdash_bylines"));
	expect(query, "expected a query against _emdash_bylines").toBeDefined();
	return { plan: explain(query!), result };
}

it("enters the byline table on the locale index", async () => {
	const { plan } = await listPlan({ locale: "en" });

	// Prefix match, so a later locale-leading composite index still passes.
	expect(plan).toMatch(/SEARCH b USING (COVERING )?INDEX idx__emdash_bylines_locale/);
	expect(plan).not.toContain("SCAN b");
});

it("keeps the locale index seek when paginating with a cursor", async () => {
	const { result: firstPage } = await listPlan({ locale: "en", limit: 5 });
	expect(firstPage.nextCursor).toBeTruthy();

	const { plan } = await listPlan({ locale: "en", limit: 5, cursor: firstPage.nextCursor! });

	// The cursor predicate is an OR over (display_name, id); it must not cost
	// the locale index.
	expect(plan).toMatch(/SEARCH b USING (COVERING )?INDEX idx__emdash_bylines_locale/);
	expect(plan).not.toContain("SCAN b");
});

it("reaches the avatar's media row by primary key", async () => {
	const { plan } = await listPlan({ locale: "en" });

	// The join exists so a page rendering avatars doesn't issue a media lookup
	// per byline — it has to stay a per-row seek to be worth it.
	expect(plan).toMatch(/SEARCH m USING (COVERING )?INDEX sqlite_autoindex_media_1 \(id=\?\)/);
	expect(plan).not.toContain("SCAN m");
});
