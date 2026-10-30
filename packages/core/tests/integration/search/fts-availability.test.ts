import { DatabaseSync } from "node:sqlite";

import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as enableSearch } from "../../../src/astro/routes/api/search/enable.js";
import { GET as search } from "../../../src/astro/routes/api/search/index.js";
import { POST as rebuildSearch } from "../../../src/astro/routes/api/search/rebuild.js";
import { GET as suggest } from "../../../src/astro/routes/api/search/suggest.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { getSuggestions, searchCollection, searchWithDb } from "../../../src/search/query.js";
import { applySeed } from "../../../src/seed/apply.js";
import { connectMcpHarness, extractText } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

// Run this file on both FTS5-enabled Node builds and builds without FTS5
// (for example Node 23.11.0).
const probe = new DatabaseSync(":memory:");
let hasFts5 = false;
try {
	probe.exec("CREATE VIRTUAL TABLE probe USING fts5(x)");
	hasFts5 = true;
} catch (error) {
	if (!(error instanceof Error) || !error.message.includes("no such module: fts5")) throw error;
} finally {
	probe.close();
}

describe("FTS5 availability", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	function context(path: string, request?: Request): APIContext {
		return {
			url: new URL(`http://localhost/_emdash/api/search${path}`),
			request,
			locals: { emdash: { db }, user: { id: "admin", role: Role.ADMIN } },
		} as unknown as APIContext;
	}

	it.runIf(hasFts5)(
		"keeps empty searches successful when FTS5 is available but no collections are enabled",
		async () => {
			const response = await search(context("?q=hello"));
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ success: true, data: { items: [] } });
		},
	);

	it.skipIf(hasFts5)(
		"reports unavailable search even when there are no collection metadata rows",
		async () => {
			for (const handler of [search, suggest]) {
				const response = await handler(context("?q=hello"));
				expect(response.status).toBe(503);
				expect(await response.json()).toMatchObject({
					success: false,
					error: { code: "SEARCH_UNAVAILABLE", message: expect.stringContaining("FTS5") },
				});
			}
		},
	);

	it.skipIf(hasFts5)("preserves the unavailable error code for MCP clients", async () => {
		const harness = await connectMcpHarness({ db, userId: "admin", userRole: Role.ADMIN });
		try {
			const result = await harness.client.callTool({
				name: "search",
				arguments: { query: "hello" },
			});
			expect(result.isError).toBe(true);
			expect(result._meta).toMatchObject({ code: "SEARCH_UNAVAILABLE" });
			expect(extractText(result)).toContain("[SEARCH_UNAVAILABLE]");
			expect(extractText(result)).toContain("FTS5");
		} finally {
			await harness.cleanup();
		}
	});

	it.skipIf(hasFts5)(
		"reports unavailable search after seed setup succeeds without an index",
		async () => {
			const result = await applySeed(
				db,
				{
					version: "1",
					collections: [
						{
							slug: "posts",
							label: "Posts",
							supports: ["search"],
							fields: [{ slug: "title", label: "Title", type: "string", searchable: true }],
						},
					],
					content: {
						posts: [
							{ id: "hello", slug: "hello", status: "published", data: { title: "Hello world" } },
						],
					},
				},
				{ includeContent: true },
			);
			expect(result.content.created).toBe(1);
			expect((await new FTSManager(db).getSearchConfig("posts"))?.enabled).not.toBe(true);
			const response = await search(context("?q=hello"));
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				success: false,
				error: { code: "SEARCH_UNAVAILABLE" },
			});
		},
	);

	it.skipIf(hasFts5)("does not turn a failed enable into successful empty results", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts", supports: ["search"] });
		await registry.createField("posts", {
			slug: "title",
			label: "Title",
			type: "string",
			searchable: true,
		});

		const response = await enableSearch(
			context(
				"/enable",
				new Request("http://localhost", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ collection: "posts", enabled: true }),
				}),
			),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			success: false,
			error: { code: "SEARCH_UNAVAILABLE", message: expect.stringContaining("FTS5") },
		});
		expect((await new FTSManager(db).getSearchConfig("posts"))?.enabled).not.toBe(true);

		const result = await search(context("?q=hello"));
		expect(result.status).toBe(503);
		await expect(searchWithDb(db, "hello")).rejects.toThrow(/FTS5/);
		await expect(searchCollection(db, "posts", "hello")).rejects.toThrow(/FTS5/);
		await expect(getSuggestions(db, "hello")).rejects.toThrow(/FTS5/);

		// An index created by an FTS5-enabled runtime remains in sqlite_master
		// after switching builds. Install its schema without loading the module.
		await sql`PRAGMA writable_schema = ON`.execute(db);
		await sql`INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql)
			VALUES ('table', '_emdash_fts_posts', '_emdash_fts_posts', 0,
				'CREATE VIRTUAL TABLE _emdash_fts_posts USING fts5(id UNINDEXED, locale UNINDEXED, title)')`.execute(
			db,
		);
		await sql`PRAGMA writable_schema = RESET`.execute(db);
		await new FTSManager(db).setSearchConfig("posts", { enabled: true });
		const rebuild = await rebuildSearch(
			context(
				"/rebuild",
				new Request("http://localhost", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ collection: "posts" }),
				}),
			),
		);
		expect(rebuild.status).toBe(503);
		expect(await rebuild.json()).toMatchObject({
			success: false,
			error: { code: "SEARCH_UNAVAILABLE" },
		});
		await expect(new FTSManager(db).enableSearch("posts")).rejects.toThrow(/FTS5/);
		await expect(new FTSManager(db).disableSearch("posts")).rejects.toThrow(/FTS5/);
	});
});
