import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CoalescingD1Dialect } from "../../../cloudflare/src/db/coalescing-d1.js";
import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import type { Database } from "../../src/database/types.js";
import { FTSManager } from "../../src/search/fts-manager.js";
import { getSuggestions, searchWithDb } from "../../src/search/query.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

type Counter = { individual: number; batch: number };

function countedBinding(counter: Counter): D1Database {
	const statementTargets = new WeakMap<object, object>();
	const terminalMethods = new Set(["all", "first", "run", "raw"]);

	function unwrap<T>(value: T): T {
		return (
			value !== null && (typeof value === "object" || typeof value === "function")
				? (statementTargets.get(value as object) ?? value)
				: value
		) as T;
	}

	function wrapStatement<T extends object>(statement: T): T {
		const proxy = new Proxy(statement, {
			get(target, property) {
				const member = Reflect.get(target, property, target);
				if (typeof member !== "function") return member;
				if (property === "bind") {
					return (...args: unknown[]) => wrapStatement(Reflect.apply(member, target, args));
				}
				return (...args: unknown[]) => {
					if (terminalMethods.has(String(property))) counter.individual++;
					return member.apply(target, args.map(unwrap));
				};
			},
		});
		statementTargets.set(proxy, statement);
		return proxy;
	}

	return new Proxy(env.DB, {
		get(target, property) {
			if (property === "batch") {
				return (statements: D1PreparedStatement[]) => {
					counter.batch++;
					return target.batch(statements.map(unwrap));
				};
			}
			if (property === "prepare") {
				return (...args: unknown[]) => wrapStatement(Reflect.apply(target.prepare, target, args));
			}
			const member = Reflect.get(target, property, target);
			return typeof member === "function" ? member.bind(target) : member;
		},
	});
}

const counter: Counter = { individual: 0, batch: 0 };
const rawCounter: Counter = { individual: 0, batch: 0 };
let db: Kysely<Database>;
let rawDb: Kysely<Database>;

function resetCounter(value: Counter) {
	value.individual = 0;
	value.batch = 0;
}
function physicalCalls(value: Counter) {
	return value.individual + value.batch;
}

async function createCollection(
	database: Kysely<Database>,
	slug: string,
	config: string | null = JSON.stringify({ enabled: true }),
	withIndex = true,
) {
	const contentTable = sql.ref(`ec_${slug}`);
	const ftsTable = sql.ref(`_emdash_fts_${slug}`);
	await sql`
		INSERT INTO _emdash_collections (id, slug, search_config, title_field)
		VALUES (${`${slug}-id`}, ${slug}, ${config}, 'title')
	`.execute(database);
	await sql`
		INSERT INTO _emdash_fields (collection_id, slug, type, validation, searchable)
		VALUES (${`${slug}-id`}, 'title', 'text', NULL, 1)
	`.execute(database);
	await sql`
		CREATE TABLE ${contentTable} (
			id TEXT PRIMARY KEY, slug TEXT, locale TEXT NOT NULL, status TEXT NOT NULL,
			deleted_at TEXT, title TEXT
		)
	`.execute(database);
	await sql`
		INSERT INTO ${contentTable} (id, slug, locale, status, title)
		VALUES (${`${slug}-row`}, ${slug}, 'en', 'published', 'same words')
	`.execute(database);
	if (withIndex) {
		await sql`
			CREATE VIRTUAL TABLE ${ftsTable} USING fts5(id UNINDEXED, locale UNINDEXED, title)
		`.execute(database);
		await sql`
			INSERT INTO ${ftsTable} (id, locale, title)
			VALUES (${`${slug}-row`}, 'en', 'same words')
		`.execute(database);
	}
}

async function createSchema(database: Kysely<Database>) {
	await resetD1Schema(database);
	await sql`CREATE TABLE _emdash_collections (
		id TEXT PRIMARY KEY, slug TEXT NOT NULL, search_config TEXT, title_field TEXT
	)`.execute(database);
	await sql`CREATE TABLE _emdash_fields (
		collection_id TEXT NOT NULL, slug TEXT NOT NULL, type TEXT NOT NULL,
		validation TEXT, searchable INTEGER NOT NULL DEFAULT 0
	)`.execute(database);
}

beforeAll(() => {
	db = new Kysely<Database>({
		dialect: new CoalescingD1Dialect({ database: countedBinding(counter) }),
	});
	rawDb = new Kysely<Database>({
		dialect: new RawBindingD1Dialect({ database: countedBinding(rawCounter) }),
	});
});

afterAll(async () => {
	await db.destroy();
	await rawDb.destroy();
});

beforeEach(async () => {
	resetCounter(counter);
	resetCounter(rawCounter);
	await createSchema(db);
});

describe("coalesced D1 search", () => {
	it.each([2, 9])("uses metadata plus one MATCH batch for %i collections", async (count) => {
		for (let i = 0; i < count; i++) await createCollection(db, `collection_${i}`);
		resetCounter(counter);

		const result = await searchWithDb(db, "same");

		expect(result.items).toHaveLength(count);
		expect(physicalCalls(counter)).toBe(2);
		expect(counter.batch).toBe(1);
	});

	it("keeps explicit collection order when scores are identical", async () => {
		await createCollection(db, "first");
		await createCollection(db, "second");
		await createCollection(db, "third");
		// Ranking uses the entry ID as its final tie-breaker across collections.
		for (const slug of ["first", "second", "third"]) {
			await sql`UPDATE ${sql.ref(`ec_${slug}`)} SET id = 'shared-id'`.execute(db);
			await sql`UPDATE ${sql.ref(`_emdash_fts_${slug}`)} SET id = 'shared-id'`.execute(db);
		}
		resetCounter(counter);

		const result = await searchWithDb(db, "same", {
			collections: ["third", "first", "second"],
		});

		expect(result.items.map((item) => item.collection)).toEqual(["third", "first", "second"]);
		expect(physicalCalls(counter)).toBe(2);
	});

	it.each([2, 9])(
		"batches suggestions, preserves explicit collection order, and applies the limit for %i collections",
		async (count) => {
			for (let i = 0; i < count; i++) await createCollection(db, `collection_${i}`);
			resetCounter(counter);

			const collections = Array.from({ length: count }, (_, i) => `collection_${count - i - 1}`);
			const result = await getSuggestions(db, "same", { collections, limit: 2 });

			expect(result).toHaveLength(2);
			expect(result.map((suggestion) => suggestion.collection)).toEqual(collections.slice(0, 2));
			expect(physicalCalls(counter)).toBe(2);
			expect(counter.batch).toBe(1);
		},
	);

	it.each([searchWithDb, getSuggestions])(
		"propagates the first collection's structural error from %s",
		async (search) => {
			await createCollection(db, "first");
			await createCollection(db, "second");
			await sql`UPDATE _emdash_collections SET title_field = 'missing_first' WHERE slug = 'first'`.execute(
				db,
			);
			await sql`UPDATE _emdash_collections SET title_field = 'missing_second' WHERE slug = 'second'`.execute(
				db,
			);
			resetCounter(counter);

			await expect(search(db, "same", { collections: ["second", "first"] })).rejects.toThrow(
				"missing_second",
			);
			expect(counter.batch).toBe(1);
		},
	);

	it("falls back to individual search queries when a malformed FTS query rejects the batch", async () => {
		await createCollection(db, "first");
		await createCollection(db, "second");
		resetCounter(counter);

		await expect(searchWithDb(db, '"foo AND')).resolves.toEqual({ items: [] });
		expect(counter.batch).toBe(1);
		expect(physicalCalls(counter)).toBe(4);
	});

	it("falls back to individual suggestion queries when a malformed FTS query rejects the batch", async () => {
		await createCollection(db, "first");
		await createCollection(db, "second");
		resetCounter(counter);

		await expect(getSuggestions(db, '"foo AND')).resolves.toEqual([]);
		expect(counter.batch).toBe(1);
		expect(physicalCalls(counter)).toBe(4);
	});
});

describe("coalesced FTS health checks", () => {
	it.each([{ checkRowCounts: false }, {}])(
		"uses two calls for nine healthy indexes (%o)",
		async (options) => {
			for (let i = 0; i < 9; i++) await createCollection(rawDb, `collection_${i}`);
			resetCounter(rawCounter);

			await expect(new FTSManager(rawDb).verifyAndRepairAll(options)).resolves.toBe(0);
			expect(physicalCalls(rawCounter)).toBe(2);
		},
	);

	it("repairs missing and empty indexes", async () => {
		await createCollection(rawDb, "missing", JSON.stringify({ enabled: true }), false);
		await createCollection(rawDb, "empty");
		await sql`DELETE FROM ${sql.ref("_emdash_fts_empty")}`.execute(rawDb);
		resetCounter(rawCounter);

		const manager = new FTSManager(rawDb);
		await expect(manager.verifyAndRepairAll({ checkRowCounts: false })).resolves.toBe(2);
		expect(await manager.ftsTableExists("missing")).toBe(true);
		expect(
			(await searchWithDb(rawDb, "same")).items.map((item) => item.collection).toSorted(),
		).toEqual(["empty", "missing"]);
	});

	it("continues repairing other indexes when a health probe fails", async () => {
		await createCollection(rawDb, "broken");
		await sql`DROP TABLE ${sql.ref("ec_broken")}`.execute(rawDb);
		await createCollection(rawDb, "healthy");
		await sql`DELETE FROM ${sql.ref("_emdash_fts_healthy")}`.execute(rawDb);
		resetCounter(rawCounter);

		const manager = new FTSManager(rawDb);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(manager.verifyAndRepairAll({ checkRowCounts: false })).resolves.toBe(1);
			expect(await manager.ftsTableExists("healthy")).toBe(true);
			expect((await searchWithDb(rawDb, "same", { collections: ["healthy"] })).items).toEqual([
				expect.objectContaining({ collection: "healthy", slug: "healthy" }),
			]);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("skips disabled and malformed configurations", async () => {
		await createCollection(rawDb, "disabled", JSON.stringify({ enabled: false }));
		await createCollection(rawDb, "malformed", "not-json");
		resetCounter(rawCounter);

		await expect(new FTSManager(rawDb).verifyAndRepairAll()).resolves.toBe(0);
		expect(physicalCalls(rawCounter)).toBe(1);
	});

	it.each([{ checkRowCounts: false }, {}])(
		"splits health probes after forty collections (%o)",
		async (options) => {
			for (let i = 0; i < 41; i++) await createCollection(rawDb, `collection_${i}`);
			resetCounter(rawCounter);

			await expect(new FTSManager(rawDb).verifyAndRepairAll(options)).resolves.toBe(0);
			expect(physicalCalls(rawCounter)).toBe(3);
		},
	);
});
