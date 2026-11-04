import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { Database } from "../../src/database/types.js";
import { emdashLoader, LARGE_TERM_ASSIGNMENTS, resetTaxonomyNamesCache } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

/**
 * A listing filtered by two taxonomies reads about as many rows whichever
 * taxonomy the caller's `where` names first.
 */
const COLLECTION = "pivot_order_d1";
const ENTRIES = 1500;
/**
 * `category: broad` tags every second entry, `category: rare` every 300th and
 * `tag: narrow` every 50th.
 */
const BROAD_EVERY = 2;
const RARE_EVERY = 300;
const NARROW_EVERY = 50;

interface Measurement {
	queries: number;
	rowsRead: number;
}

let db: Kysely<Database>;

function measuringDb(measurement: Measurement): Kysely<Database> {
	const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
		new Proxy(statement, {
			get(target, property) {
				if (property === "bind") {
					return (...values: unknown[]) => wrapStatement(target.bind(...values));
				}
				if (property === "all") {
					return async <T>() => {
						const result = await target.all<T>();
						measurement.queries++;
						measurement.rowsRead += result.meta.rows_read;
						return result;
					};
				}
				const value: unknown = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	const database = new Proxy(env.DB, {
		get(target, property) {
			if (property === "prepare") return (query: string) => wrapStatement(target.prepare(query));
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database }) });
}

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await resetD1Schema(db);
	await runMigrations(db);
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: COLLECTION, label: "Pivot order" });
	await registry.createField(COLLECTION, { slug: "title", label: "Title", type: "string" });
	await db
		.updateTable("_emdash_taxonomy_def_groups")
		.set({ collections: JSON.stringify([COLLECTION]) })
		.where("name", "in", ["category", "tag"])
		.execute();
	resetTaxonomyNamesCache();

	await sql`
		WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${ENTRIES})
		INSERT INTO ${sql.ref(`ec_${COLLECTION}`)}
			(id, slug, status, locale, translation_group, created_at, updated_at, published_at, title)
		SELECT printf('e%05d', i), printf('e-%05d', i), 'published', 'en', printf('e%05d', i),
			datetime('2024-01-01', printf('+%d minutes', i)),
			datetime('2024-01-01', printf('+%d minutes', i)),
			datetime('2024-01-01', printf('+%d minutes', i)),
			printf('Entry %d', i)
		FROM seq
	`.execute(db);

	const taxonomies = new TaxonomyRepository(db);
	const broad = await taxonomies.create({ name: "category", slug: "broad", label: "Broad" });
	const rare = await taxonomies.create({ name: "category", slug: "rare", label: "Rare" });
	const narrow = await taxonomies.create({ name: "tag", slug: "narrow", label: "Narrow" });
	for (const [term, every] of [
		[broad, BROAD_EVERY],
		[rare, RARE_EVERY],
		[narrow, NARROW_EVERY],
	] as const) {
		await sql`
			INSERT INTO content_taxonomies (collection, entry_id, taxonomy_id)
			SELECT ${COLLECTION}, translation_group, ${term.translationGroup}
			FROM ${sql.ref(`ec_${COLLECTION}`)}
			WHERE CAST(substr(id, 2) AS INTEGER) % ${every} = 0
		`.execute(db);
	}
}, 60_000);

afterAll(async () => {
	await db.destroy();
});

async function load(
	where: Record<string, string | string[]>,
	orderBy: Record<string, "asc" | "desc">,
) {
	const measurement: Measurement = { queries: 0, rowsRead: 0 };
	const measured = measuringDb(measurement);
	const result = await runWithContext({ db: measured, editMode: false }, () =>
		emdashLoader().loadCollection!({
			filter: { type: COLLECTION, where, orderBy, limit: 10 },
		}),
	);
	await measured.destroy();
	if (result.error) throw result.error;
	return { ids: result.entries.map((entry) => entry.id), ...measurement };
}

describe("two-taxonomy listing on D1", () => {
	it.each([
		["one slug", { published_at: "desc" as const }, "broad"],
		["one slug", { updated_at: "desc" as const }, "broad"],
		["a rare and a broad slug", { published_at: "desc" as const }, ["rare", "broad"]],
	])(
		"reads about the same rows for either where key order (%s, %o)",
		async (_shape, orderBy, category) => {
			// Warm the per-isolate taxonomy caches so both orders run the same queries.
			await load({ tag: "narrow" }, orderBy);
			const broadFirst = await load({ category, tag: "narrow" }, orderBy);
			const narrowFirst = await load({ tag: "narrow", category }, orderBy);

			expect(broadFirst.ids).toHaveLength(10);
			expect(broadFirst.ids).toEqual(narrowFirst.ids);
			expect(broadFirst.queries).toBe(narrowFirst.queries);
			// The orders differ only in how far the first size probe reads, at
			// most LARGE_TERM_ASSIGNMENTS entries. Seeking from `category` would
			// read its 750 or more assignments and their content rows.
			expect(Math.abs(broadFirst.rowsRead - narrowFirst.rowsRead)).toBeLessThan(
				LARGE_TERM_ASSIGNMENTS + 100,
			);
		},
	);
});
