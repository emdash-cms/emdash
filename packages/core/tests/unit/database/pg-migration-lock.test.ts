import { PostgresDialect } from "kysely";
import { describe, expect, it } from "vitest";

import { FailFastPostgresDialect } from "../../../src/database/pg-migration-lock.js";

/**
 * The dialect must change only `acquireMigrationLock`. If it dropped the
 * adapter's capability flags, the Kysely Migrator would stop running
 * migrations inside a transaction (supportsTransactionalDdl) — silently
 * breaking rollback-on-failure. The lock behavior itself is covered by the
 * Postgres integration tests (migration-lock-pg.test.ts).
 */
describe("FailFastPostgresDialect", () => {
	it("preserves the stock adapter's capability flags", () => {
		const stock = new PostgresDialect({ pool: {} as never }).createAdapter();
		const adapter = new FailFastPostgresDialect({ pool: {} as never }).createAdapter();

		expect(adapter.supportsTransactionalDdl).toBe(true);
		expect(adapter.supportsTransactionalDdl).toBe(stock.supportsTransactionalDdl);
		expect(adapter.supportsReturning).toBe(stock.supportsReturning);
		expect(adapter.supportsCreateIfNotExists).toBe(stock.supportsCreateIfNotExists ?? false);
		expect(adapter.supportsMultipleConnections).toBe(stock.supportsMultipleConnections ?? true);
	});

	it("still identifies as PostgresAdapter for dialect detection", () => {
		// detectDialect() (dialect-helpers.ts) matches on the adapter's
		// constructor name; a differently-named adapter class would make
		// every dialect helper emit SQLite SQL against Postgres.
		const adapter = new FailFastPostgresDialect({ pool: {} as never }).createAdapter();
		expect(adapter.constructor.name).toBe("PostgresAdapter");
	});

	it("remains a PostgresDialect for the public dialect type", () => {
		// `emdash/db/postgres` publicly returns PostgresDialect; the fail-fast
		// dialect must not narrow or break that type contract.
		expect(new FailFastPostgresDialect({ pool: {} as never })).toBeInstanceOf(PostgresDialect);
	});
});
