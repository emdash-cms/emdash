import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	destroySharedPool,
	hasPgTestDatabase,
	setupTestPostgresDatabase,
	teardownTestPostgresDatabase,
	type PgTestContext,
} from "../../utils/test-db.js";

const describePostgres = hasPgTestDatabase ? describe : describe.skip;

describePostgres("indexed custom-field ordering [postgres]", () => {
	let ctx: PgTestContext | undefined;
	let indexName: string;
	let localeIndexName: string;
	let planIndexName: string;
	let planLocaleIndexName: string;
	let repo: ContentRepository;

	beforeAll(async () => {
		ctx = await setupTestPostgresDatabase();
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
		const field = await registry.createField("post", {
			slug: "priority",
			label: "Priority",
			type: "number",
			indexed: true,
		});
		indexName = `idx_cf_${field.id.toLowerCase()}`;
		localeIndexName = `${indexName}_loc`;
		repo = new ContentRepository(ctx.db);

		await registry.createCollection({ slug: "plan", label: "Plans", labelSingular: "Plan" });
		const planField = await registry.createField("plan", {
			slug: "priority",
			label: "Priority",
			type: "number",
			indexed: true,
		});
		planIndexName = `idx_cf_${planField.id.toLowerCase()}`;
		planLocaleIndexName = `${planIndexName}_loc`;
		await sql`
			INSERT INTO ec_plan (id, locale, priority)
			SELECT 'plan-en-' || i::text, 'en', (i % 20)::double precision
			FROM generate_series(1, 1100) AS series(i)
		`.execute(ctx.db);
		await sql`
			INSERT INTO ec_plan (id, locale, priority)
			SELECT 'plan-nl-' || i::text, 'nl', (i % 5)::double precision
			FROM generate_series(1, 20) AS series(i)
		`.execute(ctx.db);
		await sql`ANALYZE ec_plan`.execute(ctx.db);

		for (const priority of [null, null, 1, 1, 2, 2]) {
			await repo.create({ type: "post", data: { priority } });
		}
	}, 30_000);

	afterAll(async () => {
		try {
			if (ctx) await teardownTestPostgresDatabase(ctx);
		} finally {
			await destroySharedPool();
		}
	});

	it("uses separate indexes for global and locale-scoped ordering", async () => {
		const plans = await ctx!.db.transaction().execute(async (trx) => {
			await sql`SET LOCAL enable_seqscan = off`.execute(trx);
			await sql`SET LOCAL enable_bitmapscan = off`.execute(trx);
			const global = await sql<{ "QUERY PLAN": string }>`
				EXPLAIN (FORMAT TEXT)
				SELECT * FROM ec_plan
				WHERE deleted_at IS NULL
				ORDER BY (priority IS NOT NULL) ASC, priority ASC, id ASC
				LIMIT 4
			`.execute(trx);
			const localized = await sql<{ "QUERY PLAN": string }>`
				EXPLAIN (FORMAT TEXT)
				SELECT * FROM ec_plan
				WHERE deleted_at IS NULL AND locale = 'nl'
				ORDER BY (priority IS NOT NULL) ASC, priority ASC, id ASC
				LIMIT 4
			`.execute(trx);
			return {
				global: global.rows.map((row) => row["QUERY PLAN"]).join("\n"),
				localized: localized.rows.map((row) => row["QUERY PLAN"]).join("\n"),
			};
		});

		expect(plans.global).toContain(`Index Scan using ${planIndexName}`);
		expect(plans.global).not.toContain("Sort");
		expect(plans.localized).toContain(`Index Scan using ${planLocaleIndexName}`);
		expect(plans.localized).toContain("locale = 'nl'::text");
		expect(plans.localized).not.toContain("Sort");
	});

	it("creates the physical custom-field index", async () => {
		const result = await sql<{ indexname: string; indexdef: string }>`
			SELECT indexname, indexdef
			FROM pg_indexes
			WHERE schemaname = ${ctx!.schemaName}
				AND tablename = 'ec_post'
				AND indexname IN (${indexName}, ${localeIndexName})
		`.execute(ctx!.db);

		expect(result.rows).toHaveLength(2);
		const definitions = new Map(
			result.rows.map((row) => [row.indexname, row.indexdef.replaceAll('"', "")]),
		);
		expect(definitions.get(indexName)).toContain(
			"USING btree (((priority IS NOT NULL)), priority, id)",
		);
		expect(definitions.get(localeIndexName)).toContain(
			"USING btree (locale, ((priority IS NOT NULL)), priority, id)",
		);
	});

	it.each([
		["asc", [null, null, 1, 1, 2, 2]],
		["desc", [2, 2, 1, 1, null, null]],
	] as const)(
		"keeps %s null ordering stable across two cursor pages",
		async (direction, expected) => {
			const first = await repo.findMany("post", {
				limit: 3,
				orderBy: { field: "priority", direction },
			});
			expect(first.nextCursor).toBeDefined();

			const second = await repo.findMany("post", {
				limit: 3,
				cursor: first.nextCursor,
				orderBy: { field: "priority", direction },
			});
			const items = [...first.items, ...second.items];

			expect(items.map((item) => item.data.priority ?? null)).toEqual(expected);
			expect(new Set(items.map((item) => item.id)).size).toBe(6);
			expect(first.total).toBe(6);
			expect(second.total).toBe(6);
			expect(second.nextCursor).toBeUndefined();
		},
	);
});
