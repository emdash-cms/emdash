import { type Kysely, sql } from "kysely";

import type { Database } from "../../src/database/types.js";

/**
 * Names that may be interpolated into raw SQL here.
 *
 * The core tables start with an underscore, which `validateIdentifier()` from
 * `database/validate.ts` rejects, so this is a local widening of that pattern
 * rather than a call to it. The names come from `sqlite_master`, but AGENTS.md
 * asks for a check before any identifier reaches `sql.raw`.
 */
const SAFE_OBJECT_NAME = /^[a-z_][a-z0-9_]*$/;

function safeName(name: string): string {
	if (!SAFE_OBJECT_NAME.test(name)) {
		throw new Error(`resetD1Schema refuses to interpolate the object name: ${name}`);
	}
	return name;
}

/**
 * Drop every object in the D1 database so the next test starts empty.
 *
 * The pool's D1 binding keeps its contents for the whole test file, and D1
 * enforces foreign keys with no way to suspend them, so tables are dropped
 * children first.
 */
export async function resetD1Schema(db: Kysely<Database>): Promise<void> {
	for (const type of ["view", "trigger"] as const) {
		const objects = await sql<{ name: string }>`
			SELECT name FROM sqlite_master WHERE type = ${type} AND name NOT LIKE 'sqlite_%'
		`.execute(db);
		for (const { name } of objects.rows) {
			await sql.raw(`DROP ${type.toUpperCase()} IF EXISTS "${safeName(name)}"`).execute(db);
		}
	}

	for (const name of await dropOrder(db)) {
		await sql.raw(`DROP TABLE IF EXISTS "${safeName(name)}"`).execute(db);
	}

	const left = await listTables(db);
	if (left.length > 0) {
		throw new Error(`resetD1Schema left tables behind: ${left.join(", ")}`);
	}
}

/**
 * Order the tables so each one is dropped before the tables it points at.
 * Self-references are ignored; a reference cycle is reported, not spun on.
 */
async function dropOrder(db: Kysely<Database>): Promise<string[]> {
	const parents = new Map<string, Set<string>>();
	for (const table of await listTables(db)) {
		const rows = await sql<{ table: string }>`PRAGMA foreign_key_list(${sql.ref(table)})`.execute(
			db,
		);
		parents.set(table, new Set(rows.rows.map((row) => row.table).filter((name) => name !== table)));
	}

	const ordered: string[] = [];
	while (parents.size > 0) {
		const referenced = new Set([...parents.values()].flatMap((set) => [...set]));
		const free = [...parents.keys()].filter((table) => !referenced.has(table));
		if (free.length === 0) {
			throw new Error(`resetD1Schema found a foreign-key cycle: ${[...parents.keys()].join(", ")}`);
		}
		for (const table of free) parents.delete(table);
		ordered.push(...free);
	}
	return ordered;
}

/** User table names currently in the database, in no particular order. */
export async function listTables(db: Kysely<Database>): Promise<string[]> {
	const rows = await sql<{ name: string }>`
		SELECT name FROM sqlite_master
		WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
	`.execute(db);
	return rows.rows.map((row) => row.name);
}

/** Index names declared on a table, excluding the ones SQLite creates itself. */
export async function listIndexes(db: Kysely<Database>, table: string): Promise<string[]> {
	const rows = await sql<{ name: string }>`
		SELECT name FROM sqlite_master
		WHERE type = 'index' AND tbl_name = ${table} AND name NOT LIKE 'sqlite_%'
	`.execute(db);
	return rows.rows.map((row) => row.name).toSorted();
}

/** Column names of a table in declaration order. */
export async function listColumns(db: Kysely<Database>, table: string): Promise<string[]> {
	const rows = await sql<{ name: string }>`PRAGMA table_info(${sql.ref(table)})`.execute(db);
	return rows.rows.map((row) => row.name);
}
