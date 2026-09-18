import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import * as migration055 from "../../../src/database/migrations/055_content_translation_group_locale_index.js";
import * as migration080 from "../../../src/database/migrations/080_content_translation_locale_unique.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	type DialectTestContext,
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
} from "../../utils/test-db.js";

/**
 * The longest collection slug `SchemaRegistry` can create on Postgres: at 47
 * characters the `deleted_updated_id` and `deleted_status` index names collide
 * once Postgres truncates identifiers to 63 bytes. `idx_{table}_tg_locale` and
 * `idx_{table}_del_tg_locale` are truncated at this length too, so the
 * migration's creates and drop must still name three different indexes.
 */
const LONG_SLUG = `t${"o".repeat(45)}`;
const TABLE_NAME = `ec_${LONG_SLUG}`;

describeEachDialect("translation_group index replacement for long collection slugs", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: LONG_SLUG, label: "Long", labelSingular: "Long" });

		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${TABLE_NAME}_tg_locale`)}`.execute(ctx.db);
		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${TABLE_NAME}_del_tg_locale`)}`.execute(ctx.db);
		await sql`
			CREATE INDEX ${sql.ref(`idx_${TABLE_NAME}_translation_group`)}
			ON ${sql.ref(TABLE_NAME)} (translation_group)
		`.execute(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("keeps both lookup indexes and the active-locale uniqueness index distinct", async () => {
		await migration055.up(ctx.db);

		const covering = (await translationIndexes()).filter((index) =>
			index.columns.includes("translation_group"),
		);
		expect(covering).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: expectedName(`idx_${TABLE_NAME}_tg_locale`),
					columns: "translation_group, locale",
					unique: false,
				}),
				expect.objectContaining({
					name: expectedName(`idx_${TABLE_NAME}_del_tg_locale`),
					columns: "deleted_at, translation_group, locale",
					unique: false,
				}),
				expect.objectContaining({
					name: expectedName(`uidx_${TABLE_NAME}_active_tg_locale`),
					columns: "translation_group, lower(locale)",
					unique: true,
				}),
			]),
		);
		expect(covering).toHaveLength(3);
	});

	it("drops the active-locale uniqueness index on rollback", async () => {
		await migration080.up(ctx.db);
		await migration080.down(ctx.db);

		const indexes = await translationIndexes();
		expect(indexes).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: expectedName(`uidx_${TABLE_NAME}_active_tg_locale`),
				}),
			]),
		);
	});

	function expectedName(name: string): string {
		return ctx.dialect === "postgres" ? name.slice(0, 63) : name;
	}

	async function translationIndexes(): Promise<
		Array<{ name: string; columns: string; unique: boolean }>
	> {
		if (ctx.dialect === "postgres") {
			const result = await sql<{ indexname: string; indexdef: string }>`
				SELECT indexname, indexdef FROM pg_indexes
				WHERE schemaname = current_schema() AND tablename = ${TABLE_NAME}
			`.execute(ctx.db);
			return result.rows.map((row) => ({
				name: row.indexname,
				columns: columnList(row.indexdef),
				unique: row.indexdef.startsWith("CREATE UNIQUE INDEX"),
			}));
		}

		const result = await sql<{ name: string; sql: string | null }>`
			SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ${TABLE_NAME}
		`.execute(ctx.db);
		return result.rows.map((row) => ({
			name: row.name,
			columns: columnList(row.sql ?? ""),
			unique: row.sql?.startsWith("CREATE UNIQUE INDEX") ?? false,
		}));
	}
});

function columnList(definition: string): string {
	const open = definition.indexOf("(", definition.indexOf(" ON "));
	const predicate = definition.indexOf(") WHERE", open);
	const close = predicate === -1 ? definition.lastIndexOf(")") : predicate;
	if (open === -1 || close < open) return "";
	return definition
		.slice(open + 1, close)
		.replaceAll('"', "")
		.replaceAll(/\s+/g, " ")
		.trim();
}
