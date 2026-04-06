/**
 * Kysely dialect for Durable Object preview databases
 *
 * Proxies all queries to an EmDashPreviewDB DO instance via RPC.
 * Preview mode is read-only — no transaction support needed.
 */

import type {
	CompiledQuery,
	DatabaseConnection,
	DatabaseIntrospector,
	Dialect,
	Driver,
	Kysely,
	QueryResult,
} from "kysely";
import { SqliteAdapter, SqliteQueryCompiler } from "kysely";

import type { Database } from "emdash";
import { D1Introspector } from "./d1-introspector.js";
import type { QueryResult as DOQueryResult } from "./do-class.js";

/**
 * Minimal interface for the DO stub's RPC methods.
 *
 * We define this instead of using DurableObjectStub<EmDashPreviewDB> directly
 * because Rpc.Result<T> resolves to `never` when the return type contains
 * `unknown` (Record<string, unknown> in QueryResult.rows). This interface
 * gives us clean typing without fighting the Rpc type system.
 */
export interface PreviewDBStub {
	query(sql: string, params?: unknown[]): Promise<DOQueryResult>;
}

export interface PreviewDODialectConfig {
	/**
	 * Factory that returns a fresh DO stub on each call.
	 *
	 * DO stubs are bound to the request context that created them.
	 * Since the Kysely instance may be cached across requests, we can't
	 * hold a single stub — each connection must get a fresh one via
	 * namespace.get(id), which is cheap (no RPC, just a local ref).
	 */
	getStub: () => PreviewDBStub;
}

export class PreviewDODialect implements Dialect {
	readonly #config: PreviewDODialectConfig;

	constructor(config: PreviewDODialectConfig) {
		this.#config = config;
	}

	createAdapter(): SqliteAdapter {
		return new SqliteAdapter();
	}

	createDriver(): Driver {
		return new PreviewDODriver(this.#config);
	}

	createQueryCompiler(): SqliteQueryCompiler {
		return new SqliteQueryCompiler();
	}

	createIntrospector(db: Kysely<Database>): DatabaseIntrospector {
		return new D1Introspector(db);
	}
}

class PreviewDODriver implements Driver {
	readonly #config: PreviewDODialectConfig;

	constructor(config: PreviewDODialectConfig) {
		this.#config = config;
	}

	async init(): Promise<void> {}

	async acquireConnection(): Promise<DatabaseConnection> {
		return new PreviewDOConnection(this.#config.getStub());
	}

	async beginTransaction(): Promise<void> {
		// No-op. Preview is read-only.
	}

	async commitTransaction(): Promise<void> {
		// No-op.
	}

	async rollbackTransaction(): Promise<void> {
		// No-op.
	}

	async releaseConnection(): Promise<void> {}

	async destroy(): Promise<void> {}
}

class PreviewDOConnection implements DatabaseConnection {
	readonly #stub: PreviewDBStub;

	constructor(stub: PreviewDBStub) {
		this.#stub = stub;
	}

	async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
		const sqlText = compiledQuery.sql;
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- CompiledQuery.parameters is ReadonlyArray<unknown>, stub expects unknown[]
		const params = compiledQuery.parameters as unknown[];

		const result = await this.#stub.query(sqlText, params);

		return {
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Kysely generic O is the caller's row type; we trust the DB returned matching rows
			rows: result.rows as O[],
			numAffectedRows: result.changes !== undefined ? BigInt(result.changes) : undefined,
		};
	}

	// eslint-disable-next-line require-yield -- interface requires AsyncIterableIterator but DO doesn't support streaming
	async *streamQuery<O>(): AsyncIterableIterator<QueryResult<O>> {
		throw new Error("Preview DO dialect does not support streaming");
	}
}
