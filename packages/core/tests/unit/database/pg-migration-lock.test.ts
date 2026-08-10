import { Kysely, PostgresDialect } from "kysely";
import { describe, expect, it } from "vitest";

import { detectDialect } from "../../../src/database/dialect-helpers.js";
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

	it("detects Postgres when a bundler renames the adapter class", () => {
		const db = new Kysely({
			dialect: new FailFastPostgresDialect({ pool: {} as never }),
		});
		const constructor = db.getExecutor().adapter.constructor;
		const originalName = Object.getOwnPropertyDescriptor(constructor, "name");

		try {
			Object.defineProperty(constructor, "name", { value: "a", configurable: true });
			expect(detectDialect(db)).toBe("postgres");
		} finally {
			if (originalName) Object.defineProperty(constructor, "name", originalName);
		}
	});

	it("remains a PostgresDialect for the public dialect type", () => {
		// `emdash/db/postgres` publicly returns PostgresDialect; the fail-fast
		// dialect must not narrow or break that type contract.
		expect(new FailFastPostgresDialect({ pool: {} as never })).toBeInstanceOf(PostgresDialect);
	});
});
