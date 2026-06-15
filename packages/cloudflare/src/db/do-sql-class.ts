/**
 * EmDashDB — production Durable Object database
 *
 * Holds the full CMS SQLite database inside a single Durable Object. One DO
 * instance == one database. With read replication enabled, Cloudflare runs
 * the same class on replica instances near readers; this class detects which
 * role it is and routes accordingly:
 *
 *   - Reads run locally on whichever instance answers (nearest replica when
 *     one exists, else the primary).
 *   - Writes always run on the primary. A replica proxies writes to its
 *     primary stub.
 *   - Read-your-writes is provided via the bookmarks API: a write returns the
 *     current bookmark, and a later read can wait for a replica to catch up to
 *     that bookmark before serving.
 *
 * Unlike `EmDashPreviewDB`, this is a long-lived production database: no TTL,
 * no snapshot import, no auto-drop.
 *
 * Known limitations (vs. the Node/D1 backends):
 *   - Connection-scoped PRAGMAs don't persist. Each RPC `exec` auto-commits and,
 *     on replicas vs. primary, may not even run on the connection that later
 *     writes. So `PRAGMA foreign_keys = ON/OFF` / `defer_foreign_keys` set in one
 *     statement won't affect a later one. DO SQLite enforces foreign keys by
 *     default; migrations that rely on toggling FK enforcement mid-run need a
 *     different approach here.
 *   - No interactive transactions (see do-sql-dialect.ts) -- matches D1.
 */

import { DurableObject } from "cloudflare:workers";

import type { DOQueryResult, DOQueryStatement, EmDashDBStub } from "./do-sql-types.js";
import { isReadStatement } from "./do-sql-types.js";

/**
 * Experimental Durable Object read-replication surface on `ctx.storage`, not
 * yet present in `@cloudflare/workers-types`. Declared narrowly and accessed
 * via feature detection so the class still works (as a plain single-instance
 * database) before the `replica_routing` flag is enabled.
 *
 *   - `primary`: RPC stub to the primary DO when THIS instance is a replica;
 *     `undefined` when this instance is the primary.
 *   - `enableReplicas()`: called on the primary to turn on read replication.
 *   - `getCurrentBookmark()` / `waitForBookmark()`: the bookmarks API for
 *     read-your-writes.
 */
interface ReplicationStorage {
	primary?: EmDashDBStub;
	enableReplicas?: () => void;
	getCurrentBookmark?: () => Promise<string>;
	waitForBookmark?: (bookmark: string) => Promise<void>;
}

const READONLY_ERROR_PATTERN = /readonly database/i;

function isReadonlyError(error: unknown): boolean {
	return error instanceof Error && READONLY_ERROR_PATTERN.test(error.message);
}

export class EmDashDB extends DurableObject {
	/** Whether we've already asked the primary to enable replication. */
	#replicationConfigured = false;

	/** The replication surface on `ctx.storage` (experimental, feature-detected). */
	get #replication(): ReplicationStorage {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- experimental replication API not yet in workers-types
		return this.ctx.storage as unknown as ReplicationStorage;
	}

	/** The primary stub when this instance is a replica; `undefined` on the primary. */
	get #primaryStub(): EmDashDBStub | undefined {
		return this.#replication.primary;
	}

	get #isReplica(): boolean {
		return this.#primaryStub !== undefined;
	}

	/**
	 * Enable read replication on the primary. Idempotent and cheap; Cloudflare
	 * allows calling it repeatedly. No-op on a replica (only the primary enables
	 * replication) and when the flag/API isn't present.
	 */
	#ensureReplication(): void {
		if (this.#replicationConfigured || this.#isReplica) return;
		this.#replication.enableReplicas?.();
		this.#replicationConfigured = true;
	}

	async #currentBookmark(): Promise<string | undefined> {
		return this.#replication.getCurrentBookmark?.();
	}

	/**
	 * Execute a single SQL statement. Called via RPC from the Kysely driver.
	 *
	 * @param opts.bookmark On a replica read, wait until this instance has
	 *   caught up to the given bookmark before serving (read-your-writes).
	 */
	async query(
		sql: string,
		params?: unknown[],
		opts?: { bookmark?: string },
	): Promise<DOQueryResult> {
		this.#ensureReplication();
		const isRead = isReadStatement(sql);

		// Writes must hit the primary. On a replica, proxy to it.
		if (!isRead && this.#isReplica) {
			return this.#primaryStub!.query(sql, params);
		}

		// Read-your-writes: on a replica, wait until our copy reflects the
		// bookmark the caller last observed before reading. Best-effort: a
		// stale, expired, or malformed bookmark must NOT fail the read -- that
		// would 500 every read for a client until its cookie cleared, with no
		// self-heal. Log and serve a possibly-stale read instead (it heals on
		// the next request once a fresh bookmark is minted).
		if (isRead && opts?.bookmark && this.#isReplica) {
			try {
				await this.#replication.waitForBookmark?.(opts.bookmark);
			} catch (error) {
				// Tension worth naming: we can't tell a stale/expired cookie bookmark
				// (swallowing is correct -- it self-heals next request) from a
				// transient failure on a fresh in-request write bookmark (swallowing
				// briefly hides a real read-after-write inconsistency, e.g. create()
				// then findById()). Swallowing wins because the alternative -- 500ing
				// every read until a bad cookie clears -- is strictly worse and has no
				// self-heal. Fresh-bookmark failures are rare (same-primary) and retry
				// on the next request.
				console.error("[emdash:do] waitForBookmark failed; serving possibly-stale read:", error);
			}
		}

		let cursor;
		try {
			cursor = params?.length
				? this.ctx.storage.sql.exec(sql, ...params)
				: this.ctx.storage.sql.exec(sql);
		} catch (error) {
			// A write misclassified as a read (e.g. a write-CTE) hit a replica's
			// read-only database. Retry on the primary so the heuristic only ever
			// costs latency, never correctness.
			if (this.#isReplica && isReadonlyError(error)) {
				return this.#primaryStub!.query(sql, params);
			}
			throw error;
		}

		const rows: Record<string, unknown>[] = [];
		for (const row of cursor) {
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- SqlStorageCursor yields record-like objects
			rows.push(row as Record<string, unknown>);
		}

		// Treat the statement as a write if the prefix heuristic said so OR it
		// actually mutated rows. The rowsWritten check catches write-CTEs and
		// PRAGMA writes the heuristic classifies as reads: on the primary those
		// would otherwise drop their bookmark (breaking read-your-writes) and
		// report no affected rows. (On a replica a misclassified write throws
		// readonly above and is retried on the primary, so it never reaches here.)
		const wrote = !isRead || cursor.rowsWritten > 0;
		if (!wrote) {
			return { rows };
		}
		return { rows, changes: cursor.rowsWritten, bookmark: await this.#currentBookmark() };
	}

	/**
	 * Execute several read statements in a single RPC, returning one result per
	 * statement in order. This is the round-trip win: a page that issues ~17
	 * reads becomes one RPC instead of N.
	 *
	 * Read-only by construction -- the coalescing dialect only ever buffers
	 * plain SELECTs (writes take the single-`query` path). So we wait on the
	 * bookmark once for the whole batch, then run each `exec` synchronously
	 * (a consistent snapshot, since a DO is single-threaded and there are no
	 * awaits between execs) and return just rows. No per-statement bookmark is
	 * minted (reads don't advance the write bookmark).
	 *
	 * If any statement throws, the whole RPC rejects; the caller falls back to
	 * running each statement via `query()` individually, which preserves
	 * per-statement error semantics and the readonly-retry path.
	 */
	async batchQuery(
		statements: DOQueryStatement[],
		opts?: { bookmark?: string },
	): Promise<DOQueryResult[]> {
		this.#ensureReplication();

		if (opts?.bookmark && this.#isReplica) {
			try {
				await this.#replication.waitForBookmark?.(opts.bookmark);
			} catch (error) {
				console.error(
					"[emdash:do] waitForBookmark failed (batch); serving possibly-stale reads:",
					error,
				);
			}
		}

		return statements.map((statement) => {
			const cursor = statement.params?.length
				? this.ctx.storage.sql.exec(statement.sql, ...statement.params)
				: this.ctx.storage.sql.exec(statement.sql);
			const rows: Record<string, unknown>[] = [];
			for (const row of cursor) {
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- SqlStorageCursor yields record-like objects
				rows.push(row as Record<string, unknown>);
			}
			return { rows };
		});
	}
}
