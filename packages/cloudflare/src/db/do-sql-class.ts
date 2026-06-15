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

import type { DOQueryResult, EmDashDBStub } from "./do-sql-types.js";
import { isReadStatement } from "./do-sql-types.js";

/**
 * Experimental Durable Object replication surface, not yet present in
 * `@cloudflare/workers-types`. Declared narrowly and accessed via feature
 * detection so the class still works (as a plain single-instance database)
 * before the `replica_routing` flag is enabled.
 *
 * The wiki documents `primaryStub` on the state in some places and on storage
 * in others, so we probe both.
 */
interface ReplicationState {
	primaryStub?: EmDashDBStub;
	configureReadReplication?: (opts: { mode: "auto" | "disabled" }) => void;
}
interface ReplicationStorage {
	primaryStub?: EmDashDBStub;
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

	/** The primary stub when this instance is a replica; `undefined` on the primary. */
	get #primaryStub(): EmDashDBStub | undefined {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- experimental replication API not yet in workers-types
		const state = this.ctx as unknown as ReplicationState;
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- experimental replication API not yet in workers-types
		const storage = this.ctx.storage as unknown as ReplicationStorage;
		return state.primaryStub ?? storage.primaryStub;
	}

	get #isReplica(): boolean {
		return this.#primaryStub !== undefined;
	}

	/**
	 * Enable automatic read replication on the primary. Idempotent and cheap;
	 * Cloudflare allows calling it repeatedly. No-op on a replica (only the
	 * primary configures replication) and when the flag isn't enabled.
	 */
	#ensureReplication(): void {
		if (this.#replicationConfigured || this.#isReplica) return;
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- experimental replication API not yet in workers-types
		const state = this.ctx as unknown as ReplicationState;
		state.configureReadReplication?.({ mode: "auto" });
		this.#replicationConfigured = true;
	}

	async #currentBookmark(): Promise<string | undefined> {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- experimental replication API not yet in workers-types
		const storage = this.ctx.storage as unknown as ReplicationStorage;
		return storage.getCurrentBookmark?.();
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
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- experimental replication API not yet in workers-types
			const storage = this.ctx.storage as unknown as ReplicationStorage;
			try {
				await storage.waitForBookmark?.(opts.bookmark);
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
}
