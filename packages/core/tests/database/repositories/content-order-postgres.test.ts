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
		repo = new ContentRepository(ctx.db);

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

	it("creates the physical custom-field index", async () => {
		const result = await sql<{ indexdef: string }>`
			SELECT indexdef
			FROM pg_indexes
			WHERE schemaname = ${ctx!.schemaName}
				AND tablename = 'ec_post'
				AND indexname = ${indexName}
		`.execute(ctx!.db);

		expect(result.rows).toHaveLength(1);
		const definition = result.rows[0]!.indexdef.replaceAll('"', "");
		expect(definition).toContain("deleted_at");
		expect(definition).toContain("(priority IS NOT NULL)");
		expect(definition).toContain("priority, id");
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
