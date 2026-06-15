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
 */

import { DurableObject } from "cloudflare:workers";

import type { DOBatchStatement, DOQueryResult, EmDashDBStub } from "./do-sql-types.js";
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

		// Read-your-writes: block until our replica copy reflects the client's
		// last observed write before reading.
		if (isRead && opts?.bookmark && this.#isReplica) {
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- experimental replication API not yet in workers-types
			const storage = this.ctx.storage as unknown as ReplicationStorage;
			await storage.waitForBookmark?.(opts.bookmark);
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

		if (isRead) {
			return { rows };
		}
		return { rows, changes: cursor.rowsWritten, bookmark: await this.#currentBookmark() };
	}

	/**
	 * Execute multiple statements in a single synchronous transaction.
	 *
	 * Always a write path, so it runs on the primary (proxied from a replica).
	 * Used where atomic multi-statement application is required.
	 */
	async batch(statements: DOBatchStatement[]): Promise<DOQueryResult> {
		if (this.#isReplica) {
			return this.#primaryStub!.batch(statements);
		}
		this.#ensureReplication();
		this.ctx.storage.transactionSync(() => {
			for (const stmt of statements) {
				if (stmt.params?.length) {
					this.ctx.storage.sql.exec(stmt.sql, ...stmt.params);
				} else {
					this.ctx.storage.sql.exec(stmt.sql);
				}
			}
		});
		return { rows: [], bookmark: await this.#currentBookmark() };
	}
}
