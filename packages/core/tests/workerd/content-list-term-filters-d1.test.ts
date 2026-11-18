import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { handleContentCreate, handleContentList } from "../../src/api/handlers/content.js";
import { handleTaxonomyCreate } from "../../src/api/handlers/taxonomies.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

/**
 * The content list's term filter on D1: it must stay under D1's bound-parameter
 * limit however many slugs are picked, and a narrow term must not make the list
 * or its count read the whole collection.
 */
const COLLECTION = "term_list_d1";
const ENTRIES = 400;
const NARROW_ENTRIES = 3;
/** More taxonomies than D1's five compound-SELECT terms. */
const FACETS = ["facet_a", "facet_b", "facet_c", "facet_d", "facet_e", "facet_f"];

let db: Kysely<Database>;
const rows = { read: 0, log: [] as string[] };

function countRows(database: D1Database): D1Database {
	return new Proxy(database, {
		get(target, property) {
			if (property === "prepare") {
				return (query: string) => countStatement(target.prepare(query), query);
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function countStatement(statement: D1PreparedStatement, query = ""): D1PreparedStatement {
	return new Proxy(statement, {
		get(target, property) {
			if (property === "bind") {
				return (...values: unknown[]) => countStatement(target.bind(...values), query);
			}
			if (property === "all") {
				return async <T>() => {
					const result = await target.all<T>();
					rows.read += result.meta.rows_read;
					rows.log.push(`${result.meta.rows_read} ${query.slice(0, 300)}`);
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
	await registry.createCollection({ slug: COLLECTION, label: "Term list" });
	await registry.createField(COLLECTION, { slug: "title", label: "Title", type: "string" });
	await registry.createField(COLLECTION, {
		slug: "queue",
		label: "Queue",
		type: "string",
		indexed: true,
	});
	const created = await handleTaxonomyCreate(db, {
		name: "topics",
		label: "Topics",
		collections: [COLLECTION],
	});
	if (!created.success) throw new Error("Failed to create taxonomy");

	const taxonomies = new TaxonomyRepository(db);
	const broad = await taxonomies.create({ name: "topics", slug: "broad", label: "Broad" });
	const narrow = await taxonomies.create({ name: "topics", slug: "narrow", label: "Narrow" });
	const facetGroups: string[] = [];
	for (const name of FACETS) {
		// oxlint-disable-next-line no-await-in-loop -- deterministic fixture setup
		const facet = await handleTaxonomyCreate(db, { name, label: name, collections: [COLLECTION] });
		if (!facet.success) throw new Error("Failed to create taxonomy");
		// oxlint-disable-next-line no-await-in-loop -- deterministic fixture setup
		const term = await taxonomies.create({ name, slug: "picked", label: "Picked" });
		facetGroups.push(term.translationGroup!);
	}
	for (let i = 0; i < ENTRIES; i++) {
		// oxlint-disable-next-line no-await-in-loop -- deterministic fixture setup
		const result = await handleContentCreate(db, COLLECTION, {
			data: { title: `Entry ${i}`, queue: i % 2 === 0 ? "even" : "odd" },
			createdAt: new Date(Date.UTC(2020, 0, 1, 0, i)).toISOString(),
		});
		if (!result.success) throw new Error("Failed to create entry");
		const groups = [broad.translationGroup!];
		if (i < NARROW_ENTRIES) groups.push(narrow.translationGroup!, ...facetGroups);
		// Carries every facet but the last, so it must not match all six.
		if (i === NARROW_ENTRIES) groups.push(...facetGroups.slice(0, -1));
		// oxlint-disable-next-line no-await-in-loop -- deterministic fixture setup
		await taxonomies.attachGroupsToEntry(COLLECTION, result.data!.item.id, groups);
	}
}, 120_000);

afterAll(async () => {
	await db.destroy();
});

async function list(params: Parameters<typeof handleContentList>[2]) {
	const counted = new Kysely<Database>({
		dialect: new RawBindingD1Dialect({ database: countRows(env.DB) }),
	});
	rows.read = 0;
	rows.log = [];
	const result = await handleContentList(counted, COLLECTION, params);
	return { result, rowsRead: rows.read };
}

describe("content list term filters on D1", () => {
	it("reads fewer rows than the collection has entries for a narrow term", async () => {
		const narrow = await list({ termFilters: { topics: ["narrow"] } });
		const narrowLog = rows.log;
		const both = await list({ termFilters: { topics: ["broad", "narrow"] }, limit: 10 });

		expect(narrow.result.success).toBe(true);
		expect(narrow.result.data!.total).toBe(NARROW_ENTRIES);
		expect(narrow.result.data!.items).toHaveLength(NARROW_ENTRIES);
		expect(narrow.rowsRead, narrowLog.join("\n")).toBeLessThan(ENTRIES);
		expect(both.result.data!.total).toBe(ENTRIES);
	});

	it("loads a list filtered by more than 100 slugs, field filters and bylines", async () => {
		const slugs = [...Array.from({ length: 150 }, (_, index) => `missing-${index}`), "narrow"];

		const filtered = await list({
			termFilters: { topics: slugs },
			fieldFilters: { queue: { in: Array.from({ length: 40 }, (_, index) => `queue-${index}`) } },
			bylines: Array.from({ length: 25 }, (_, index) => `byline-${index}`),
			includeInferredBylines: true,
		});
		const termsOnly = await list({
			termFilters: { topics: slugs },
			fieldFilters: { queue: "even" },
		});

		expect(filtered.result.success).toBe(true);
		expect(filtered.result.data!.total).toBe(0);
		expect(termsOnly.result.success).toBe(true);
		expect(termsOnly.result.data!.total).toBe(2);
	});

	it("ANDs more taxonomies than D1 allows compound SELECT terms", async () => {
		const termFilters = Object.fromEntries(FACETS.map((name) => [name, ["picked"]]));
		const page = await list({ termFilters, limit: 2 });

		expect(page.result.success, JSON.stringify(page.result.error)).toBe(true);
		expect(page.result.data!.total).toBe(NARROW_ENTRIES);
		expect(page.result.data!.items).toHaveLength(2);
		const next = await list({ termFilters, limit: 2, cursor: page.result.data!.nextCursor });
		expect(next.result.data!.items).toHaveLength(NARROW_ENTRIES - 2);
	});

	it("loads five taxonomies with the largest field and byline filters", async () => {
		const filtered = await list({
			termFilters: Object.fromEntries(FACETS.slice(0, 5).map((name) => [name, ["picked"]])),
			fieldFilters: { queue: { in: Array.from({ length: 40 }, (_, index) => `queue-${index}`) } },
			bylines: Array.from({ length: 25 }, (_, index) => `byline-${index}`),
			includeInferredBylines: true,
		});

		expect(filtered.result.success, JSON.stringify(filtered.result.error)).toBe(true);
		expect(filtered.result.data!.total).toBe(0);
	});
});
