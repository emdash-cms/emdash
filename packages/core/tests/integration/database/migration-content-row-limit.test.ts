import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	createMigrator,
	getExactMigrationStatus,
	MIGRATION_NAMES,
	MigrationRowLimitError,
	runMigrations,
} from "../../../src/database/migrations/runner.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	createForDialect,
	describeEachDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const NAIVE = "2012-09-12T18:00:00";

describeEachDialect("content row limit for runtime migrations", (dialect) => {
	let ctx: DialectTestContext;

	function run(contentRowLimit: number) {
		return runMigrations(ctx.db, {
			migrationTableSchema: ctx.pgCtx?.schemaName,
			contentRowLimit,
		});
	}

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("applies every migration to an empty database under a zero limit", async () => {
		ctx = await createForDialect(dialect);

		const { applied } = await run(0);

		expect(applied).toEqual(MIGRATION_NAMES);
	});

	describe("upgrading a site with content through datetime normalization", () => {
		beforeEach(async () => {
			ctx = await createForDialect(dialect);
			const { error } = await createMigrator(ctx.db, {
				migrationTableSchema: ctx.pgCtx?.schemaName,
			}).migrateTo("078_menu_item_translation_groups");
			if (error) throw error;

			const registry = new SchemaRegistry(ctx.db);
			for (const slug of ["posts", "pages"]) {
				await registry.createCollection({
					slug,
					label: slug,
					labelSingular: slug,
					supports: ["revisions"],
				});
				await sql`
					INSERT INTO ${sql.ref(`ec_${slug}`)} (
						id, slug, status, created_at, updated_at, version, locale, translation_group
					) VALUES (${slug}, ${slug}, 'draft', ${NAIVE}, ${NAIVE}, 1, 'en', ${slug})
				`.execute(ctx.db);
			}
			await ctx.db
				.insertInto("revisions")
				.values({
					id: "revision-1",
					collection: "posts",
					entry_id: "posts",
					data: JSON.stringify({ title: "Post" }),
					author_id: null,
					created_at: NAIVE,
				})
				.execute();
		});

		async function postCreatedAt(): Promise<unknown> {
			const row = await ctx.db
				.selectFrom("ec_posts" as never)
				.select("created_at" as never)
				.executeTakeFirstOrThrow();
			return (row as { created_at: unknown }).created_at;
		}

		it("refuses before applying anything when entries and revisions exceed the limit", async () => {
			const result = run(2);

			await expect(result).rejects.toBeInstanceOf(MigrationRowLimitError);
			await expect(result).rejects.toMatchObject({
				migrations: ["079_datetime_normalization"],
				rowLimit: 2,
			});
			const status = await getExactMigrationStatus(ctx.db, {
				migrationTableSchema: ctx.pgCtx?.schemaName,
			});
			expect(status.pending[0]).toBe("079_datetime_normalization");
			expect(status.pending).toHaveLength(
				MIGRATION_NAMES.length - MIGRATION_NAMES.indexOf("079_datetime_normalization"),
			);
			expect(await postCreatedAt()).toBe(NAIVE);
		});

		it("applies the pending migrations when entries and revisions fit the limit", async () => {
			const { applied } = await run(3);

			expect(applied).toEqual(
				MIGRATION_NAMES.slice(MIGRATION_NAMES.indexOf("079_datetime_normalization")),
			);
			expect(await postCreatedAt()).toBe("2012-09-12T18:00:00.000Z");
		});

		async function insertRevisions(collection: string, count: number) {
			await ctx.db
				.insertInto("revisions")
				.values(
					Array.from({ length: count }, (_, index) => ({
						id: `${collection}-revision-${index}`,
						collection,
						entry_id: collection,
						data: JSON.stringify({}),
						author_id: null,
						created_at: NAIVE,
					})),
				)
				.execute();
		}

		it("counts revisions it only reads at a fraction of a row", async () => {
			await insertRevisions("pages", 15);

			const { applied } = await run(3);

			expect(applied[0]).toBe("079_datetime_normalization");
		});

		it("counts every revision of a collection with datetime fields", async () => {
			await new SchemaRegistry(ctx.db).createField("posts", {
				slug: "starts_at",
				label: "Starts at",
				type: "datetime",
			});
			await insertRevisions("posts", 1);

			await expect(run(3)).rejects.toBeInstanceOf(MigrationRowLimitError);
		});
	});
});
