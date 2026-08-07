/**
 * Fail-fast Postgres migration locking.
 *
 * Kysely's stock `PostgresAdapter.acquireMigrationLock` runs
 * `select pg_advisory_xact_lock(...)` — an unbounded blocking wait on a
 * database-wide advisory lock, held for the whole migration transaction.
 * On Cloudflare Workers that is a stampede amplifier (#1744): every isolate
 * that cold-starts while migrations are pending parks a connection inside
 * Postgres waiting for the lock, and when the holder's migration fails and
 * rolls back, the next waiter acquires the lock and re-runs the same
 * failing migration.
 *
 * `FailFastPostgresDialect` swaps the blocking wait for
 * `pg_try_advisory_xact_lock`: when another migrator holds the lock, the
 * adapter throws `MIGRATION_LOCK_BUSY_MESSAGE` immediately instead of
 * queueing inside the database. `runMigrations` treats that error like the
 * SQLite/D1 concurrent-migration race — it polls the migration table with
 * cheap bounded SELECTs until the concurrent migrator finishes (or the
 * wait deadline passes), without holding a transaction open.
 */

import type { DialectAdapter, Kysely, MigrationLockOptions } from "kysely";
import { PostgresAdapter as KyselyPostgresAdapter, PostgresDialect, sql } from "kysely";

/**
 * Sentinel message thrown when another migrator holds the advisory lock.
 * `runMigrations` matches on it to route into the concurrent-migrator wait.
 */
export const MIGRATION_LOCK_BUSY_MESSAGE = "EMDASH_MIGRATION_LOCK_BUSY";

/**
 * Kysely's advisory lock id (LOCK_ID in kysely's postgres-adapter). Reused
 * deliberately: during a rolling deploy, old isolates still run the stock
 * blocking adapter, and using the same id keeps old and new builds mutually
 * exclusive on the same lock.
 */
const KYSELY_PG_MIGRATION_LOCK_ID = BigInt("3853314791062309107");

/**
 * Extends the stock adapter so every capability flag and `instanceof` check
 * is inherited.
 */
class PostgresAdapter extends KyselyPostgresAdapter {
	// eslint-disable-next-line typescript/no-explicit-any -- matches the DialectAdapter signature
	override async acquireMigrationLock(db: Kysely<any>, _opt: MigrationLockOptions): Promise<void> {
		// Transaction-level lock, like the stock adapter: Postgres supports
		// transactional DDL, so `db` here is the migration transaction and
		// the lock is released automatically on commit/rollback.
		const result = await sql<{ acquired: boolean }>`
			select pg_try_advisory_xact_lock(${sql.lit(KYSELY_PG_MIGRATION_LOCK_ID)}) as acquired
		`.execute(db);
		if (!result.rows[0]?.acquired) {
			throw new Error(MIGRATION_LOCK_BUSY_MESSAGE);
		}
	}
}

/**
 * Drop-in replacement for Kysely's `PostgresDialect` whose migration lock
 * fails fast instead of blocking inside the database. Everything except
 * `createAdapter` is inherited unchanged, and because it subclasses
 * `PostgresDialect`, the public dialect type of `emdash/db/postgres` stays
 * `PostgresDialect` and `instanceof` checks keep working.
 */
export class FailFastPostgresDialect extends PostgresDialect {
	override createAdapter(): DialectAdapter {
		return new PostgresAdapter();
	}
}
