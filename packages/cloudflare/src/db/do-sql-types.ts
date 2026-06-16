/**
 * Shared Durable Object SQL types and config (production)
 *
 * Imported by both the config-time entry (index.ts) and the runtime entries
 * (do-sql.ts, do-sql-dialect.ts, do-sql-class.ts). This module must NOT import
 * from cloudflare:workers so it stays safe at config time and in tests.
 */

/**
 * Durable Object SQL database configuration.
 *
 * One DO instance holds the whole CMS database (a single SQLite file).
 * With `session: "auto"` and the `experimental` + `replica_routing`
 * compatibility flags enabled, reads route to the nearest replica and writes
 * are proxied to the primary, with bookmark-based read-your-writes.
 */
export interface DurableObjectsConfig {
	/** Wrangler binding name for the DO namespace (class `EmDashDB`). */
	binding: string;

	/**
	 * Name of the singleton DO instance that holds the database.
	 *
	 * One DO == one SQLite database == the whole CMS. Defaults to `"emdash"`.
	 * Override only if you intentionally run multiple isolated databases
	 * behind a single binding.
	 *
	 * @default "emdash"
	 */
	name?: string;

	/**
	 * Read-replication routing mode.
	 *
	 * - `"disabled"` — every query goes to the single primary DO. (default)
	 * - `"auto"` — anonymous reads route to the nearest replica; writes are
	 *   proxied to the primary, and authenticated requests get read-your-writes
	 *   consistency via a bookmark cookie.
	 *
	 * `"auto"` requires the `experimental` and `replica_routing` compatibility
	 * flags in wrangler. `EmDashDB` enables replication on the primary
	 * automatically (via `ctx.storage.enableReplicas()`).
	 *
	 * @default "disabled"
	 */
	session?: "disabled" | "auto";

	/**
	 * Cookie name for the read-your-writes bookmark.
	 * Only used when `session` is `"auto"`.
	 *
	 * @default "__em_do_bookmark"
	 */
	bookmarkCookie?: string;
}

/** A single statement for `batchQuery`. */
export interface DOQueryStatement {
	sql: string;
	params?: unknown[];
}

/** Result shape returned by the `EmDashDB` RPC methods. */
export interface DOQueryResult {
	rows: Record<string, unknown>[];
	/** Rows written. `undefined` for read-only statements. */
	changes?: number;
	/**
	 * Replication bookmark captured after a write, used for read-your-writes.
	 * `undefined` for reads or when replication is not enabled.
	 */
	bookmark?: string;
}

/**
 * Minimal RPC surface of an `EmDashDB` Durable Object stub.
 *
 * Declared here (rather than using `DurableObjectStub<EmDashDB>`) because
 * `Rpc.Result<T>` collapses to `never` when the return type contains
 * `unknown` (the `Record<string, unknown>` rows). This interface keeps the
 * driver and request-scoped code free of `cloudflare:workers` types.
 */
export interface EmDashDBStub {
	query(sql: string, params?: unknown[], opts?: { bookmark?: string }): Promise<DOQueryResult>;
	batchQuery(
		statements: DOQueryStatement[],
		opts?: { bookmark?: string },
	): Promise<DOQueryResult[]>;
}

/**
 * Leading-keyword match for read-only statements. Anchored at the start so it
 * only inspects the first token -- it never upper-cases the whole SQL body
 * (content queries can carry many KB of portable-text JSON / IN-lists, and this
 * runs on every query, both in the dialect and the DO RPC handler).
 */
const READ_STATEMENT_PATTERN = /^\s*(?:select|pragma|explain|with)\b/i;

/** Leading-keyword match for PRAGMA statements. */
const PRAGMA_STATEMENT_PATTERN = /^\s*pragma\b/i;

/**
 * Heuristic: does this statement only read?
 *
 * Used to decide replica-vs-primary routing. `WITH` is treated as a read
 * because read CTEs dominate; a write-CTE misrouted to a replica throws a
 * "readonly database" error, which the DO catches and retries on the primary
 * (see `EmDashDB.query`), so the heuristic only affects latency, never
 * correctness.
 */
export function isReadStatement(sql: string): boolean {
	return READ_STATEMENT_PATTERN.test(sql);
}

/**
 * Whether the statement is a PRAGMA. PRAGMA mutations (e.g. `PRAGMA user_version`)
 * change no rows, so the row-count write heuristic misses them; callers use this
 * to still capture a replication bookmark for read-your-writes.
 */
export function isPragmaStatement(sql: string): boolean {
	return PRAGMA_STATEMENT_PATTERN.test(sql);
}
