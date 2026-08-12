/**
 * Query-plan coverage for translation-group reads on content tables.
 *
 * SQLite runs without ANALYZE/sqlite_stat1 here, matching D1's stats-blind
 * planner. Result parity for these reads is covered by the i18n suite.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import * as migration055 from "../../../src/database/migrations/055_content_translation_group_locale_index.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database as DatabaseSchema } from "../../../src/database/types.js";
import { getMenuWithDb } from "../../../src/menus/index.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { SQL_BATCH_SIZE } from "../../../src/utils/chunks.js";

interface CapturedQuery {
	sql: string;
	parameters: readonly unknown[];
}

let sqlite: Database.Database;
let db: Kysely<DatabaseSchema>;
let repo: ContentRepository;
let captured: CapturedQuery[];

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
	await runMigrations(db);
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
	repo = new ContentRepository(db);

	for (let index = 1; index <= 200; index++) {
		const group = `tg-${String(Math.ceil(index / 2)).padStart(4, "0")}`;
		sqlite
			.prepare(
				`INSERT INTO ec_post (id, slug, status, locale, translation_group, created_at, updated_at, version)
				 VALUES (?, ?, 'published', ?, ?, '2025-01-01', '2025-01-01', 1)`,
			)
			.run(`id-${index}`, `slug-${index}`, index % 2 === 0 ? "en" : "de", group);
	}
	captured = [];
});

afterEach(async () => {
	await db.destroy();
});

it("seeks a single translation group through the translation_group index", async () => {
	const items = await repo.findTranslations("post", "tg-0005");

	expect(items.map((item) => item.locale)).toEqual(["de", "en"]);

	const query = translationQuery();
	const plan = explain(query);
	expect(contentAccess(plan)).toMatch(
		/SEARCH ec_post USING (?:COVERING )?INDEX idx_ec_post_del_tg_locale \(deleted_at=\? AND translation_group=\?\)/,
	);
	expect(plan).not.toContain("SCAN ec_post");
	expect(plan).not.toContain("idx_ec_post_loc_crt");
	expect(plan).not.toContain("idx_ec_post_loc_upd");
});

it.each([
	{ groupCount: 2, publishedOnly: false },
	{ groupCount: 2, publishedOnly: true },
	{ groupCount: SQL_BATCH_SIZE, publishedOnly: false },
	{ groupCount: SQL_BATCH_SIZE, publishedOnly: true },
])(
	"seeks $groupCount batched translation groups through the translation_group index (publishedOnly=$publishedOnly)",
	async ({ groupCount, publishedOnly }) => {
		const groups = Array.from(
			{ length: groupCount },
			(_, index) => `tg-${String(index + 1).padStart(4, "0")}`,
		);

		const items = await repo.findTranslationsForGroups("post", groups, { publishedOnly });

		expect(items).toHaveLength(groupCount * 2);

		const plan = explain(translationQuery());
		expect(contentAccess(plan)).toContain("INDEX idx_ec_post_del_tg_locale");
		expect(plan).not.toContain("SCAN ec_post");
		expect(plan).not.toContain("idx_ec_post_loc_crt");
		expect(plan).not.toContain("idx_ec_post_loc_upd");
	},
);

/**
 * Menu references resolve a translation group without a `deleted_at` filter, so
 * they need an index that leads with `translation_group`. `fr` has no `ec_post`
 * row, which exercises the any-locale fallback as well as the direct lookup.
 */
it.each([
	{ locale: "en", url: "/post/slug-10" },
	{ locale: "fr", url: "/post/slug-9" },
])("seeks a menu content reference resolved for $locale", async ({ locale, url }) => {
	await seedMenuReference("tg-0005");

	const menu = await getMenuWithDb("primary", db, { locale });

	expect(menu?.items.map((item) => item.url)).toEqual([url]);

	const queries = translationQueries();
	expect(queries.length).toBeGreaterThan(0);
	for (const query of queries) {
		const plan = explain(query);
		expect(contentAccess(plan)).toContain("INDEX idx_ec_post_tg_locale");
		expect(plan).not.toContain("SCAN ec_post");
		expect(plan).not.toContain("idx_ec_post_loc_crt");
		expect(plan).not.toContain("idx_ec_post_loc_upd");
	}
});

it("migrates a pre-055 table off the single-column translation_group index", async () => {
	sqlite.exec(`DROP INDEX idx_ec_post_tg_locale`);
	sqlite.exec(`DROP INDEX idx_ec_post_del_tg_locale`);
	sqlite.exec(`CREATE INDEX idx_ec_post_translation_group ON ec_post (translation_group)`);
	captured = [];
	await repo.findTranslations("post", "tg-0005");
	expect(contentAccess(explain(translationQuery()))).toContain("idx_ec_post_loc_crt");

	await migration055.up(db);

	expect(indexNames()).not.toContain("idx_ec_post_translation_group");
	captured = [];
	await repo.findTranslations("post", "tg-0005");
	expect(contentAccess(explain(translationQuery()))).toMatch(
		/SEARCH ec_post USING (?:COVERING )?INDEX idx_ec_post_del_tg_locale \(deleted_at=\? AND translation_group=\?\)/,
	);

	await seedMenuReference("tg-0005");
	await getMenuWithDb("primary", db, { locale: "en" });
	expect(contentAccess(explain(translationQuery()))).toContain("INDEX idx_ec_post_tg_locale");
});

function indexNames(): string[] {
	return (
		sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as {
			name: string;
		}[]
	).map((row) => row.name);
}

async function seedMenuReference(referenceGroup: string): Promise<void> {
	for (const locale of ["en", "fr"]) {
		await db
			.insertInto("_emdash_menus")
			.values({ id: `menu-${locale}`, name: "primary", label: "Primary", locale })
			.execute();
		await db
			.insertInto("_emdash_menu_items")
			.values({
				id: `item-${locale}`,
				menu_id: `menu-${locale}`,
				parent_id: null,
				sort_order: 0,
				type: "post",
				reference_collection: "post",
				reference_id: referenceGroup,
				custom_url: null,
				label: "Post",
				title_attr: null,
				target: null,
				css_classes: null,
				locale,
				translation_group: null,
			})
			.execute();
	}
	captured = [];
}

function translationQueries(): CapturedQuery[] {
	return captured.filter((query) => query.sql.includes("translation_group"));
}

function translationQuery(): CapturedQuery {
	const queries = translationQueries();
	expect(queries).toHaveLength(1);
	return queries[0]!;
}

/** better-sqlite3 only binds primitives; coerce values captured from Kysely. */
function bindable(parameter: unknown): unknown {
	if (typeof parameter === "boolean") return parameter ? 1 : 0;
	if (parameter instanceof Date) return parameter.toISOString();
	if (parameter === undefined) return null;
	return parameter;
}

function explain(query: CapturedQuery): string {
	const rows = sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
		.all(...query.parameters.map(bindable)) as { detail: string }[];
	return rows.map((row) => row.detail).join("\n");
}

function contentAccess(plan: string): string | undefined {
	return plan.split("\n").find((detail) => /\b(?:SCAN|SEARCH) ec_post\b/.test(detail));
}
