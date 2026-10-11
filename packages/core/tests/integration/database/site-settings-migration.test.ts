import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { up } from "../../../src/database/migrations/097_site_settings.js";
import { createMigrator } from "../../../src/database/migrations/runner.js";
import {
	createForDialect,
	describeEachDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("site settings schema upgrade", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await createForDialect(dialect);
		const { error } = await createMigrator(ctx.db, {
			migrationTableSchema: ctx.pgCtx?.schemaName,
		}).migrateTo("096_editorial_site_ownership");
		if (error) throw error;
		await sql`INSERT INTO _emdash_sites (id, slug) VALUES ('foo', 'foo'), ('bar', 'bar')`.execute(
			ctx.db,
		);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("upgrades through the registered migrator", async () => {
		await sql`INSERT INTO options (name, value) VALUES ('site:title', '"Old title"')`.execute(
			ctx.db,
		);
		const result = await createMigrator(ctx.db, {
			migrationTableSchema: ctx.pgCtx?.schemaName,
		}).migrateToLatest();
		if (result.error) throw result.error;
		const row = await sql<{
			site_id: string;
		}>`SELECT site_id FROM options WHERE name = 'site:site-default:title'`.execute(ctx.db);
		expect(row.rows[0]?.site_id).toBe("site-default");
		await sql`INSERT INTO options (name, value) VALUES ('plugin:new', '1')`.execute(ctx.db);
	});

	it("backfills legacy keys without losing values or revisions", async () => {
		await sql`INSERT INTO options (name, value, revision) VALUES
			('site:title', '"Original"', 'revision-one'),
			('plugin:shared', '"Shared"', 'revision-two')`.execute(ctx.db);
		await sql`UPDATE options SET site_id = 'foo' WHERE name = 'plugin:shared'`.execute(ctx.db);
		await up(ctx.db);
		await up(ctx.db);
		const rows = await sql<{ site_id: string; name: string; value: string; revision: string }>`
			SELECT site_id, name, value, revision FROM options
			WHERE name IN ('plugin:shared', 'site:site-default:title') ORDER BY name
		`.execute(ctx.db);
		expect(rows.rows).toEqual([
			{ site_id: null, name: "plugin:shared", value: '"Shared"', revision: expect.any(String) },
			{
				site_id: "site-default",
				name: "site:site-default:title",
				value: '"Original"',
				revision: "revision-one",
			},
		]);

		await sql`INSERT INTO options (site_id, name, value) VALUES
			('foo', 'site:foo:title', '"Foo"'), ('bar', 'site:bar:title', '"Bar"')`.execute(ctx.db);
		const titles = await sql<{ site_id: string; value: string }>`
			SELECT site_id, value FROM options WHERE name LIKE 'site:%:title' ORDER BY site_id
		`.execute(ctx.db);
		expect(titles.rows).toEqual([
			{ site_id: "bar", value: '"Bar"' },
			{ site_id: "foo", value: '"Foo"' },
			{ site_id: "site-default", value: '"Original"' },
		]);
		await sql`INSERT INTO options (name, value) VALUES ('plugin:new', '1')`.execute(ctx.db);
		await expect(
			sql`INSERT INTO options (name, value) VALUES ('site:missing', '1')`.execute(ctx.db),
		).rejects.toThrow();
		await expect(
			sql`INSERT INTO options (site_id, name, value) VALUES ('foo', 'site:bar:title', '2')`.execute(
				ctx.db,
			),
		).rejects.toThrow();
		await expect(
			sql`INSERT INTO options (site_id, name, value) VALUES ('foo%', 'site:fooX:title', '2')`.execute(
				ctx.db,
			),
		).rejects.toThrow();
		await expect(
			sql`INSERT INTO options (site_id, name, value) VALUES ('foo', 'plugin:shared', '2')`.execute(
				ctx.db,
			),
		).rejects.toThrow();
		await expect(
			sql`INSERT INTO options (name, value) VALUES ('plugin:shared', '2')`.execute(ctx.db),
		).rejects.toThrow();
	});

	if (dialect === "postgres") {
		it("resumes after renaming the legacy key", async () => {
			await sql`INSERT INTO options (name, value) VALUES ('site:title', '"Original"')`.execute(
				ctx.db,
			);
			await sql`UPDATE options SET name = 'site:site-default:title' WHERE name = 'site:title'`.execute(
				ctx.db,
			);
			await up(ctx.db);
			await up(ctx.db);
		});
	}

	if (dialect === "sqlite") {
		it("resumes after table rename or population without overwriting new writes", async () => {
			await sql`INSERT INTO options (name, value) VALUES ('site:title', '"Original"')`.execute(
				ctx.db,
			);
			await sql`ALTER TABLE options RENAME TO options_site_settings_legacy`.execute(ctx.db);
			await up(ctx.db);
			await sql`INSERT INTO options (site_id, name, value) VALUES ('foo', 'site:foo:title', '"Foo"')`.execute(
				ctx.db,
			);
			await up(ctx.db);
			const titles = await sql<{
				site_id: string;
			}>`SELECT site_id FROM options WHERE name LIKE 'site:%:title' ORDER BY site_id`.execute(
				ctx.db,
			);
			expect(titles.rows).toEqual([{ site_id: "foo" }, { site_id: "site-default" }]);
		});
	}
});
