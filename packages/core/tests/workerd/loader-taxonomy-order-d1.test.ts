import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { handleContentCreate } from "../../src/api/index.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { Database } from "../../src/database/types.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

/**
 * With two taxonomy filters, the listing walks one taxonomy's pivot rows and
 * checks the other per row. It must start from the smaller one whichever key
 * the caller writes first (#3259), which is visible only in the rows D1 reads.
 */
const COLLECTION = "tax_order_d1";
const BROAD_ENTRIES = 400;
const NARROW_ENTRIES = 3;

let db: Kysely<Database>;
const rows = { read: 0 };

function countRows(database: D1Database): D1Database {
	return new Proxy(database, {
		get(target, property) {
			if (property === "prepare") {
				return (query: string) => countStatement(target.prepare(query));
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function countStatement(statement: D1PreparedStatement): D1PreparedStatement {
	return new Proxy(statement, {
		get(target, property) {
			if (property === "bind") {
				return (...values: unknown[]) => countStatement(target.bind(...values));
			}
			if (property === "all") {
				return async <T>() => {
					const result = await target.all<T>();
					rows.read += result.meta.rows_read;
					return result;
				};
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await resetD1Schema(db);
	await runMigrations(db);

	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: COLLECTION, label: "Taxonomy order" });
	await registry.createField(COLLECTION, { slug: "title", label: "Title", type: "string" });
	await db
		.updateTable("_emdash_taxonomy_def_groups")
		.set({ collections: JSON.stringify([COLLECTION]) })
		.where("name", "in", ["category", "tag"])
		.execute();

	const taxonomies = new TaxonomyRepository(db);
	const broad = await taxonomies.create({ name: "category", slug: "broad", label: "Broad" });
	const narrow = await taxonomies.create({ name: "tag", slug: "narrow", label: "Narrow" });
	for (let i = 0; i < BROAD_ENTRIES; i++) {
		// oxlint-disable-next-line no-await-in-loop -- deterministic fixture setup
		const result = await handleContentCreate(db, COLLECTION, {
			data: { title: `Entry ${i}` },
			status: "published",
			publishedAt: new Date(Date.UTC(2020, 0, 1, 0, i)).toISOString(),
		});
		if (!result.success) throw new Error("Failed to create entry");
		const groups = [broad.translationGroup!];
		if (i < NARROW_ENTRIES) groups.push(narrow.translationGroup!);
		// oxlint-disable-next-line no-await-in-loop -- deterministic fixture setup
		await taxonomies.attachGroupsToEntry(COLLECTION, result.data!.item.id, groups);
	}
}, 120_000);

afterAll(async () => {
	await db.destroy();
});

async function load(where: Record<string, string[]>) {
	const counted = new Kysely<Database>({
		dialect: new RawBindingD1Dialect({ database: countRows(env.DB) }),
	});
	rows.read = 0;
	const result = await runWithContext({ db: counted, editMode: false }, () =>
		emdashLoader().loadCollection!({ filter: { type: COLLECTION, where, limit: 10 } }),
	);
	if (result.error) throw result.error;
	return { titles: result.entries.map((entry) => entry.data.title as string), rowsRead: rows.read };
}

describe("two taxonomy filters on D1", () => {
	it("reads fewer rows than the broad term has entries, in either key order", async () => {
		// Warm the per-isolate taxonomy definitions so both reads count the same work.
		await load({ category: ["broad"], tag: ["narrow"] });

		const broadFirst = await load({ category: ["broad"], tag: ["narrow"] });
		const narrowFirst = await load({ tag: ["narrow"], category: ["broad"] });

		expect(broadFirst.titles).toHaveLength(NARROW_ENTRIES);
		expect(broadFirst.titles).toEqual(narrowFirst.titles);
		expect(broadFirst.rowsRead).toBeLessThan(BROAD_ENTRIES);
		expect(narrowFirst.rowsRead).toBeLessThan(BROAD_ENTRIES);
	});
});
