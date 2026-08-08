import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import * as migration055 from "../../../src/database/migrations/055_content_translation_group_locale_index.js";
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

	it("leaves the table with both composite indexes, not with one or none", async () => {
		await migration055.up(ctx.db);

		const covering = (await translationIndexColumns())
			.filter((columns) => columns.includes("translation_group"))
			.toSorted();
		expect(covering).toEqual([
			"deleted_at, translation_group, locale",
			"translation_group, locale",
		]);
	});

	async function translationIndexColumns(): Promise<string[]> {
		if (ctx.dialect === "postgres") {
			const result = await sql<{ indexdef: string }>`
				SELECT indexdef FROM pg_indexes
				WHERE schemaname = current_schema() AND tablename = ${TABLE_NAME}
			`.execute(ctx.db);
			return result.rows.map((row) => columnList(row.indexdef));
		}

		const result = await sql<{ sql: string | null }>`
			SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ${TABLE_NAME}
		`.execute(ctx.db);
		return result.rows.map((row) => columnList(row.sql ?? ""));
	}
});

function columnList(definition: string): string {
	const open = definition.lastIndexOf("(");
	const close = definition.lastIndexOf(")");
	if (open === -1 || close < open) return "";
	return definition
		.slice(open + 1, close)
		.replaceAll('"', "")
		.replaceAll(/\s+/g, " ")
		.trim();
}
