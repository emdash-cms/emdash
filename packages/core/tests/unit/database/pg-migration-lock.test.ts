import { PostgresDialect } from "kysely";
import { describe, expect, it } from "vitest";

import { withFailFastPgMigrationLock } from "../../../src/database/pg-migration-lock.js";

/**
 * The wrapper must change only `acquireMigrationLock`. If it dropped the
 * adapter's capability flags, the Kysely Migrator would stop running
 * migrations inside a transaction (supportsTransactionalDdl) — silently
 * breaking rollback-on-failure. The lock behavior itself is covered by the
 * Postgres integration tests (migration-lock-pg.test.ts).
 */
describe("withFailFastPgMigrationLock", () => {
	it("preserves the wrapped adapter's capability flags", () => {
		const dialect = new PostgresDialect({ pool: {} as never });
		const inner = dialect.createAdapter();
		const wrapped = withFailFastPgMigrationLock(dialect).createAdapter();

		expect(wrapped.supportsTransactionalDdl).toBe(true);
		expect(wrapped.supportsTransactionalDdl).toBe(inner.supportsTransactionalDdl);
		expect(wrapped.supportsReturning).toBe(inner.supportsReturning);
		expect(wrapped.supportsCreateIfNotExists).toBe(inner.supportsCreateIfNotExists ?? false);
		expect(wrapped.supportsMultipleConnections).toBe(inner.supportsMultipleConnections ?? true);
	});

	it("still identifies as PostgresAdapter for dialect detection", () => {
		// detectDialect() (dialect-helpers.ts) matches on the adapter's
		// constructor name; a differently-named adapter class would make
		// every dialect helper emit SQLite SQL against Postgres.
		const wrapped = withFailFastPgMigrationLock(new PostgresDialect({ pool: {} as never }));
		expect(wrapped.createAdapter().constructor.name).toBe("PostgresAdapter");
	});

	it("delegates the non-adapter dialect factories unchanged", () => {
		const dialect = new PostgresDialect({ pool: {} as never });
		const wrapped = withFailFastPgMigrationLock(dialect);

		expect(wrapped.createQueryCompiler().constructor).toBe(
			dialect.createQueryCompiler().constructor,
		);
		expect(wrapped.createDriver().constructor).toBe(dialect.createDriver().constructor);
	});
});
