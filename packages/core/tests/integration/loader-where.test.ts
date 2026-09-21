/**
 * Regression tests for collection `where` field filters.
 *
 * - An unsupported range object (e.g. `{ slug: { in: [...] } }`) must warn
 *   instead of silently dropping the filter (#3256).
 * - An array value with more elements than D1's bind-parameter budget must be
 *   chunked into OR'd `IN` clauses (#3256).
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../../src/database/repositories/content.js";
import type { Database as DatabaseSchema } from "../../src/database/types.js";
import { emdashLoader, resetTaxonomyNamesCache } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { SQL_BATCH_SIZE } from "../../src/utils/chunks.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../utils/test-db.js";

interface CapturedQuery {
	sql: string;
	parameters: readonly unknown[];
}

async function createLoggedCollectionDb(): Promise<{
	db: Kysely<DatabaseSchema>;
	captured: CapturedQuery[];
}> {
	const captured: CapturedQuery[] = [];
	const sqlite = new Database(":memory:");
	const db = new Kysely<DatabaseSchema>({
		dialect: new SqliteDialect({ database: sqlite }),
		log(event) {
			if (event.level === "query") {
				captured.push({
					sql: event.query.sql,
					parameters: event.query.parameters,
				});
			}
		},
	});

	const { runMigrations } = await import("../../src/database/migrations/runner.js");
	await runMigrations(db);
	resetTaxonomyNamesCache();
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
	await registry.createField("post", { slug: "title", label: "Title", type: "string" });

	return { db, captured };
}

describeEachDialect("loader where filters", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});
	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("warns and skips an empty range object instead of dropping the filter silently", async () => {
		// eslint-disable-next-line typescript/no-explicit-any -- schema type vs Database type
		const content = new ContentRepository(ctx.db as any);
		await content.create({
			type: "post",
			slug: "post-a",
			data: { title: "A" },
			status: "published",
			locale: "en",
		});
		await content.create({
			type: "post",
			slug: "post-b",
			data: { title: "B" },
			status: "published",
			locale: "en",
		});

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db: ctx.db }, () =>
			loader.loadCollection!({
				filter: {
					type: "post",
					where: { slug: { in: ["post-a"] } as never },
				},
			}),
		);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringMatching(/where filter.*range object.*"slug"/),
		);
		warnSpy.mockRestore();
		// eslint-disable-next-line typescript/no-explicit-any -- loader result union
		const entries = (result as any).entries as { slug: string }[];
		expect(entries).toHaveLength(2);
	});

	it("filters to a small array of exact slug matches", async () => {
		// eslint-disable-next-line typescript/no-explicit-any -- schema type vs Database type
		const content = new ContentRepository(ctx.db as any);
		await content.create({
			type: "post",
			slug: "post-a",
			data: { title: "A" },
			status: "published",
			locale: "en",
		});
		await content.create({
			type: "post",
			slug: "post-b",
			data: { title: "B" },
			status: "published",
			locale: "en",
		});

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db: ctx.db }, () =>
			loader.loadCollection!({
				filter: {
					type: "post",
					where: { slug: ["post-b"] },
				},
			}),
		);

		// eslint-disable-next-line typescript/no-explicit-any -- loader result union
		const entries = (result as any).entries as { slug: string }[];
		expect(entries).toHaveLength(1);
		expect(entries[0]?.slug).toBe("post-b");
	});
});

describe("loader where array chunking [sqlite]", () => {
	let db: Kysely<DatabaseSchema>;
	let captured: CapturedQuery[];

	beforeEach(async () => {
		const created = await createLoggedCollectionDb();
		db = created.db;
		captured = created.captured;
	});
	afterEach(async () => {
		await db.destroy();
	});

	it("chunks large IN lists to stay under D1's bind-parameter limit", async () => {
		// eslint-disable-next-line typescript/no-explicit-any -- schema type vs Database type
		const content = new ContentRepository(db as any);
		const slugs: string[] = [];
		for (let i = 0; i < 130; i++) {
			slugs.push(`slug-${i}`);
			await content.create({
				type: "post",
				slug: `slug-${i}`,
				data: { title: `Post ${i}` },
				status: "published",
				locale: "en",
			});
		}

		const loader = emdashLoader();
		captured.length = 0;
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: {
					type: "post",
					where: { slug: slugs },
					limit: 200,
				},
			}),
		);

		// eslint-disable-next-line typescript/no-explicit-any -- loader result union
		const entries = (result as any).entries as { slug: string }[];
		expect(entries).toHaveLength(130);

		const query = captured.find((q) => /"slug"\s+IN/i.test(q.sql));
		expect(query).toBeDefined();

		// Every IN clause must contain at most SQL_BATCH_SIZE placeholders.
		const inClauses = query!.sql.match(/IN \([^)]*\)/g) ?? [];
		expect(inClauses.length).toBeGreaterThan(1);
		for (const clause of inClauses) {
			const placeholders = clause.match(/\?/g) ?? [];
			expect(placeholders.length).toBeLessThanOrEqual(SQL_BATCH_SIZE);
		}
	});
});
