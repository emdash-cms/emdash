/**
 * Byline hydration on sites with no bylines.
 *
 * When `_emdash_bylines` is empty, the folded byline JSON is authoritative:
 * no credit can exist in any locale and the author fallback has no byline to
 * resolve to. Entries that merely have an `author_id` must not send the
 * batch down the byline query path — those lookups can only return zero
 * rows, and they run on every logged-out render. Once a byline row exists,
 * the author fallback must still take the query path.
 */

import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import { BylineRepository } from "../../../src/database/repositories/byline.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { emdashLoader } from "../../../src/loader.js";
import { getEmDashCollection } from "../../../src/query.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

vi.mock("astro:content", () => ({
	getLiveCollection: vi.fn(),
	getLiveEntry: vi.fn(),
}));

import { getLiveCollection } from "astro:content";

const openDbs: Kysely<Database>[] = [];

/**
 * In-memory db with a query counter on Kysely's `log` hook, so the tests can
 * assert "no byline query was issued" against real SQL (no repository mocks).
 */
async function setupCountingDb(): Promise<{
	db: Kysely<Database>;
	queries: string[];
	reset: () => void;
}> {
	const sqlite = new BetterSqlite3(":memory:");
	const queries: string[] = [];
	const db = new Kysely<Database>({
		dialect: new SqliteDialect({ database: sqlite }),
		log: (event) => {
			if (event.level === "query") queries.push(event.query.sql);
		},
	});
	openDbs.push(db);
	await runMigrations(db);
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
	await registry.createField("post", { slug: "title", label: "Title", type: "string" });
	return { db, queries, reset: () => queries.splice(0, queries.length) };
}

/** Route getLiveCollection through the real loader so folded columns flow. */
function delegateToLoader() {
	const loader = emdashLoader();
	vi.mocked(getLiveCollection).mockImplementation(async (_name: string, filter: unknown) =>
		// eslint-disable-next-line typescript/no-explicit-any -- loader filter is a runtime-validated union
		loader.loadCollection!({ filter: filter as any }),
	);
}

/** Byline lookups issued by the query path (the folded content SELECT reads
 * the byline tables too, but only inside the `ec_post` query). */
function bylineQueries(queries: string[]): string[] {
	return queries.filter(
		(q) =>
			!q.includes("ec_post") &&
			(q.includes("_emdash_content_bylines") || q.includes(`"_emdash_bylines"`)),
	);
}

describe("byline hydration with an empty bylines table", () => {
	afterEach(async () => {
		vi.mocked(getLiveCollection).mockReset();
		for (const db of openDbs.splice(0)) {
			await db.destroy();
		}
	});

	it("skips the byline query path for authored entries when no bylines exist", async () => {
		const { db, queries, reset } = await setupCountingDb();
		const repo = new ContentRepository(db);
		await repo.create({
			type: "post",
			slug: "authored",
			data: { title: "Authored Post" },
			status: "published",
			authorId: "user-1",
		});
		delegateToLoader();

		const entries = await runWithContext({ editMode: false, db }, async () => {
			reset();
			const result = await getEmDashCollection("post", { status: "published" });
			return result.entries;
		});

		expect(entries).toHaveLength(1);
		const data = entries[0]!.data as Record<string, unknown>;
		expect(data.bylines).toEqual([]);
		expect(data.byline).toBeNull();
		expect(bylineQueries(queries)).toEqual([]);
	});

	it("still resolves the author fallback through the query path when a byline exists", async () => {
		const { db } = await setupCountingDb();
		await db
			.insertInto("users")
			.values({ id: "user-1", email: "ada@example.com", name: "Ada" })
			.execute();
		const bylineRepo = new BylineRepository(db);
		await bylineRepo.create({ slug: "ada", displayName: "Ada Lovelace", userId: "user-1" });
		const repo = new ContentRepository(db);
		await repo.create({
			type: "post",
			slug: "authored-with-byline",
			data: { title: "Authored Post" },
			status: "published",
			authorId: "user-1",
		});
		delegateToLoader();

		const entries = await runWithContext({ editMode: false, db }, async () => {
			const result = await getEmDashCollection("post", { status: "published" });
			return result.entries;
		});

		expect(entries).toHaveLength(1);
		const data = entries[0]!.data as { byline?: { displayName?: string } | null };
		expect(data.byline?.displayName).toBe("Ada Lovelace");
	});
});
