import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { clearMigrationLock, readMigrationLock } from "../../src/database/migration-lock.js";
import {
	ConcurrentMigrationTimeoutError,
	MIGRATION_NAMES,
	MigrationLockHeldError,
	createMigrator,
	getExactMigrationStatus,
	runMigrations,
} from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;

function connect(): Kysely<Database> {
	return new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
}

async function migrateThrough(name: string): Promise<void> {
	const { error } = await createMigrator(db).migrateTo(name);
	if (error) throw error;
}

async function holdLock(heldSince: number): Promise<void> {
	await sql`UPDATE _emdash_migrations_lock SET is_locked = ${heldSince}`.execute(db);
}

// 004 creates its tables without IF NOT EXISTS, so a second run inside it fails
// on the first CREATE, before any bookkeeping row exists.
const UNGUARDED_MIGRATION = "004_plugins";
const BEFORE_UNGUARDED = "003_schema_registry";

beforeAll(() => {
	db = connect();
});

beforeEach(async () => {
	await resetD1Schema(db);
});

afterAll(async () => {
	await db.destroy();
});

describe("migration lock on D1", () => {
	it("lets only one of two runs that start on the same unguarded migration apply it", async () => {
		await migrateThrough(BEFORE_UNGUARDED);
		const remaining = MIGRATION_NAMES.slice(MIGRATION_NAMES.indexOf(UNGUARDED_MIGRATION));
		const first = connect();
		const second = connect();
		try {
			const results = await Promise.allSettled([runMigrations(first), runMigrations(second)]);

			expect(
				results.flatMap((result) => (result.status === "rejected" ? [String(result.reason)] : [])),
			).toEqual([]);
			const applied = results.map((result) =>
				result.status === "fulfilled" ? result.value.applied : [],
			);
			expect(applied.toSorted((a, b) => a.length - b.length)).toEqual([[], remaining]);
			expect((await getExactMigrationStatus(db)).pending).toEqual([]);
			expect(await readMigrationLock(db)).toBeNull();
		} finally {
			await first.destroy();
			await second.destroy();
		}
	});

	it("fails without migrating or waiting when a lock was left long ago", async () => {
		await migrateThrough(BEFORE_UNGUARDED);
		const heldSince = Date.now() - 10 * 60_000;
		await holdLock(heldSince);

		const run = runMigrations(db);

		await expect(run).rejects.toBeInstanceOf(MigrationLockHeldError);
		await expect(run).rejects.toThrow(new Date(heldSince).toISOString());
		expect((await getExactMigrationStatus(db)).pending[0]).toBe(UNGUARDED_MIGRATION);
		expect(await readMigrationLock(db)).toBe(heldSince);
	});

	it("waits on a recent lock and leaves it to its holder", async () => {
		await migrateThrough(BEFORE_UNGUARDED);
		const heldSince = Date.now();
		await holdLock(heldSince);

		await expect(runMigrations(db, { raceWaitMs: 200 })).rejects.toBeInstanceOf(
			ConcurrentMigrationTimeoutError,
		);

		expect((await getExactMigrationStatus(db)).pending[0]).toBe(UNGUARDED_MIGRATION);
		expect(await readMigrationLock(db)).toBe(heldSince);
	});

	it("releases the lock when a migration fails", async () => {
		await migrateThrough(BEFORE_UNGUARDED);
		await sql`CREATE TABLE _plugin_storage (id TEXT)`.execute(db);

		await expect(runMigrations(db)).rejects.toThrow(/Migration failed.*004_plugins/);

		expect(await readMigrationLock(db)).toBeNull();
	});

	it("clears a lock only while it still has the confirmed value", async () => {
		await migrateThrough(BEFORE_UNGUARDED);
		const heldSince = Date.now() - 10 * 60_000;
		await holdLock(heldSince);

		await expect(clearMigrationLock(db, heldSince + 1)).resolves.toBe(false);
		expect(await readMigrationLock(db)).toBe(heldSince);

		await expect(clearMigrationLock(db, heldSince)).resolves.toBe(true);
		expect(await readMigrationLock(db)).toBeNull();
	});
});
