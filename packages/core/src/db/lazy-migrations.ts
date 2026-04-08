/**
 * Lazy migration wrapper for Kysely dialects
 *
 * Wraps a dialect so that migrations are deferred until the first schema
 * error ("no such table", "no such column"). On established sites the
 * schema is stable, so checking 30+ migrations on every cold start is
 * pure overhead. Fresh installs and upgrades are handled automatically
 * when the first query fails.
 *
 * Usage (in a database adapter's runtime entry):
 *
 * ```ts
 * import { wrapWithLazyMigrations } from "emdash/db/lazy-migrations";
 *
 * export function createDialect(config) {
 *   const base = new D1Dialect({ database: d1 });
 *   return wrapWithLazyMigrations(base);
 * }
 * ```
 */

import type {
	CompiledQuery,
	DatabaseConnection,
	DatabaseIntrospector,
	Dialect,
	Driver,
	Kysely,
	QueryCompiler,
	QueryResult,
} from "kysely";

import type { Database } from "../database/types.js";

let migrationsRun = false;

function isSchemaError(e: unknown): boolean {
	if (!(e instanceof Error)) return false;
	const msg = e.message.toLowerCase();
	return (
		// SQLite / D1
		msg.includes("no such table") ||
		msg.includes("no such column") ||
		// PostgreSQL
		(msg.includes("relation") && msg.includes("does not exist")) ||
		(msg.includes("column") && msg.includes("does not exist"))
	);
}

/**
 * Wrap a Kysely dialect with lazy migration retry.
 *
 * When a query fails with a schema error and migrations haven't been run
 * yet in this worker lifetime, runs all pending migrations then retries
 * the query once. Subsequent schema errors are thrown normally.
 */
export function wrapWithLazyMigrations(dialect: Dialect): Dialect {
	return new LazyMigrationDialect(dialect);
}

/**
 * Check if a dialect is already wrapped with lazy migration retry.
 * Used by the runtime to decide whether to run migrations eagerly.
 */
export function isLazyMigrationDialect(dialect: Dialect): boolean {
	return dialect instanceof LazyMigrationDialect;
}

class LazyMigrationDialect implements Dialect {
	readonly #inner: Dialect;

	constructor(inner: Dialect) {
		this.#inner = inner;
	}

	createAdapter() {
		return this.#inner.createAdapter();
	}

	createDriver(): Driver {
		return new LazyMigrationDriver(this.#inner.createDriver(), this.#inner);
	}

	createQueryCompiler(): QueryCompiler {
		return this.#inner.createQueryCompiler();
	}

	createIntrospector(db: Kysely<any>): DatabaseIntrospector {
		return this.#inner.createIntrospector(db);
	}
}

class LazyMigrationDriver implements Driver {
	readonly #inner: Driver;
	readonly #dialect: Dialect;

	constructor(inner: Driver, dialect: Dialect) {
		this.#inner = inner;
		this.#dialect = dialect;
	}

	async init(): Promise<void> {
		return this.#inner.init();
	}

	async acquireConnection(): Promise<DatabaseConnection> {
		const conn = await this.#inner.acquireConnection();
		return new LazyMigrationConnection(conn, this.#dialect);
	}

	async beginTransaction(conn: DatabaseConnection): Promise<void> {
		return this.#inner.beginTransaction(conn);
	}

	async commitTransaction(conn: DatabaseConnection): Promise<void> {
		return this.#inner.commitTransaction(conn);
	}

	async rollbackTransaction(conn: DatabaseConnection): Promise<void> {
		return this.#inner.rollbackTransaction(conn);
	}

	async releaseConnection(conn: DatabaseConnection): Promise<void> {
		return this.#inner.releaseConnection(conn);
	}

	async destroy(): Promise<void> {
		return this.#inner.destroy();
	}
}

class LazyMigrationConnection implements DatabaseConnection {
	readonly #inner: DatabaseConnection;
	readonly #dialect: Dialect;

	constructor(inner: DatabaseConnection, dialect: Dialect) {
		this.#inner = inner;
		this.#dialect = dialect;
	}

	async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
		try {
			return await this.#inner.executeQuery(compiledQuery);
		} catch (e) {
			if (!migrationsRun && isSchemaError(e)) {
				migrationsRun = true;
				// Create a fresh Kysely instance for migration using the inner
				// dialect (unwrapped) to avoid infinite retry loops.
				const { Kysely } = await import("kysely");
				const db = new Kysely<Database>({ dialect: this.#dialect });
				try {
					const { runMigrations } = await import(
						"../database/migrations/runner.js"
					);
					await runMigrations(db);
				} finally {
					await db.destroy();
				}
				// Retry the original query
				return this.#inner.executeQuery(compiledQuery);
			}
			throw e;
		}
	}

	async *streamQuery<O>(
		compiledQuery: CompiledQuery,
		chunkSize?: number,
	): AsyncIterableIterator<QueryResult<O>> {
		yield* this.#inner.streamQuery(compiledQuery, chunkSize);
	}
}
