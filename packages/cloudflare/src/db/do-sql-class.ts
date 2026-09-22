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
import type { CollectionDeletionGuardInput, CollectionDeletionGuardResult } from "emdash";

import type {
	DOQueryOptions,
	DOQueryResult,
	DOQueryStatement,
	EmDashDBStub,
} from "./do-sql-types.js";
import { isPragmaStatement, isReadStatement } from "./do-sql-types.js";

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
const COLLECTION_SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Upper bound on how long a read will block waiting for a replica to catch up to
 * a read-your-writes bookmark. A stale or unreachable bookmark (e.g. one minted
 * by a different DO id after a rename, or an expired one) must not make every
 * read pay the platform's full wait budget for the cookie's whole lifetime. On
 * timeout we serve a possibly-stale read; it self-heals once a fresh bookmark is
 * minted.
 */
const WAIT_FOR_BOOKMARK_TIMEOUT_MS = 250;

function isReadonlyError(error: unknown): boolean {
	return error instanceof Error && READONLY_ERROR_PATTERN.test(error.message);
}

export class EmDashDB extends DurableObject {
	/** Whether we've already asked the primary to enable replication. */
	#replicationConfigured = false;

	/** The replication surface on `ctx.storage` (experimental, feature-detected). */
	get #replication(): ReplicationStorage {
		return this.ctx.storage;
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
	 * Read-your-writes wait, bounded and best-effort. Waits for this replica to
	 * reach `bookmark`, but never longer than WAIT_FOR_BOOKMARK_TIMEOUT_MS, and
	 * never fails the read: a stale/expired/cross-id bookmark would otherwise make
	 * every read block (and, unbounded, on every request for the cookie's life).
	 * On timeout or error we serve a possibly-stale read, which self-heals once a
	 * fresh bookmark is minted. No-op on the primary / when the API is absent.
	 */
	async #waitForBookmarkBounded(bookmark: string): Promise<void> {
		const replication = this.#replication;
		if (!replication.waitForBookmark) return;
		try {
			await Promise.race([
				replication.waitForBookmark(bookmark),
				new Promise<void>((resolve) => setTimeout(resolve, WAIT_FOR_BOOKMARK_TIMEOUT_MS)),
			]);
		} catch (error) {
			// Can't distinguish a stale cookie bookmark (swallow is correct) from a
			// transient failure on a fresh in-request write bookmark (swallow briefly
			// hides a read-after-write); swallowing wins because the alternative --
			// 500ing every read until the cookie clears -- is strictly worse.
			console.error("[emdash:do] waitForBookmark failed; serving possibly-stale read:", error);
		}
	}

	/**
	 * Execute a single SQL statement. Called via RPC from the Kysely driver.
	 *
	 * @param opts.bookmark On a replica read, wait until this instance has
	 *   caught up to the given bookmark before serving (read-your-writes).
	 */
	async query(sql: string, params?: unknown[], opts?: DOQueryOptions): Promise<DOQueryResult> {
		this.#ensureReplication();
		const isRead = isReadStatement(sql);
		if (opts?.primary && this.#isReplica) {
			return this.#primaryStub!.query(sql, params, opts);
		}

		// Writes must hit the primary. On a replica, proxy to it.
		if (!isRead && this.#isReplica) {
			return this.#primaryStub!.query(sql, params);
		}

		// Read-your-writes: on a replica, wait (bounded, best-effort) until our
		// copy reflects the bookmark the caller last observed before reading.
		if (isRead && opts?.bookmark && this.#isReplica) {
			await this.#waitForBookmarkBounded(opts.bookmark);
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
			rows.push(row);
		}

		// Treat the statement as a write if the prefix heuristic said so, it
		// actually mutated rows, OR it's a PRAGMA. The rowsWritten check catches
		// write-CTEs the heuristic classifies as reads; the PRAGMA check catches
		// mutating PRAGMAs (e.g. `PRAGMA user_version = N`) that change no rows so
		// rowsWritten is 0 -- without it those would drop their bookmark and a
		// follow-up read on a replica wouldn't wait for the schema change. (On a
		// replica a misclassified write throws readonly above and is retried on the
		// primary, so it never reaches here.)
		const wrote = !isRead || cursor.rowsWritten > 0 || isPragmaStatement(sql);
		if (!wrote) {
			return { rows };
		}
		return { rows, changes: cursor.rowsWritten, bookmark: await this.#currentBookmark() };
	}

	async executeCollectionDeletionGuard(
		input: CollectionDeletionGuardInput,
	): Promise<CollectionDeletionGuardResult> {
		this.#ensureReplication();
		if (this.#isReplica) {
			return this.#primaryStub!.executeCollectionDeletionGuard(input);
		}
		assertCollectionDeletionInput(input);
		return this.ctx.storage.transactionSync(() => {
			const phase = input.action === "fence" ? "fence" : "table";
			const guard = this.ctx.storage.sql.exec(
				`SELECT collection_id
				 FROM _emdash_media_usage_collection_deletions
				 WHERE collection_id = ?
				   AND collection_slug = ?
				   AND state = 'leased'
				   AND phase = ?
				   AND lease_token = ?
				   AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
				input.collectionId,
				input.collectionSlug,
				phase,
				input.leaseToken,
			);
			if (guard.toArray().length !== 1) return { outcome: "stale" };

			const contentTable = `ec_${input.collectionSlug}`;
			if (input.action === "fence") {
				if (!input.forceDelete) {
					const content = this.ctx.storage.sql.exec(
						`SELECT 1 AS present FROM "${contentTable}" WHERE deleted_at IS NULL LIMIT 1`,
					);
					if (content.toArray().length > 0) return { outcome: "has_content" };
				}
				const updated = this.ctx.storage.sql.exec(
					`UPDATE _emdash_media_usage_index_status
					 SET capture_state = 'deleting',
					     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
					 WHERE adapter_id = 'content-media'
					   AND scope_type = 'collection'
					   AND scope_key = ?
					   AND collection_id = ?
					   AND capture_state = 'active'
					   AND EXISTS (
					       SELECT 1 FROM _emdash_collections
					       WHERE id = ? AND slug = ?
					   )`,
					input.collectionSlug,
					input.collectionId,
					input.collectionId,
					input.collectionSlug,
				);
				return updated.rowsWritten === 1 ? { outcome: "fenced" } : { outcome: "stale" };
			}

			const ftsTable = `_emdash_fts_${input.collectionSlug}`;
			this.ctx.storage.sql.exec(`DROP TRIGGER IF EXISTS "${ftsTable}_insert"`);
			this.ctx.storage.sql.exec(`DROP TRIGGER IF EXISTS "${ftsTable}_update"`);
			this.ctx.storage.sql.exec(`DROP TRIGGER IF EXISTS "${ftsTable}_delete"`);
			this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS "${ftsTable}"`);
			this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS "${contentTable}"`);
			return { outcome: "dropped" };
		});
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
		opts?: DOQueryOptions,
	): Promise<DOQueryResult[]> {
		this.#ensureReplication();
		if (opts?.primary && this.#isReplica) {
			return this.#primaryStub!.batchQuery(statements, opts);
		}

		if (opts?.bookmark && this.#isReplica) {
			await this.#waitForBookmarkBounded(opts.bookmark);
		}

		return statements.map((statement) => {
			const cursor = statement.params?.length
				? this.ctx.storage.sql.exec(statement.sql, ...statement.params)
				: this.ctx.storage.sql.exec(statement.sql);
			const rows: Record<string, unknown>[] = [];
			for (const row of cursor) {
				rows.push(row);
			}
			return { rows };
		});
	}
}

function assertCollectionDeletionInput(input: CollectionDeletionGuardInput): void {
	if (!input.collectionId || !input.leaseToken) {
		throw new Error("Collection deletion guard requires a collection ID and lease token");
	}
	if (!COLLECTION_SLUG_PATTERN.test(input.collectionSlug) || input.collectionSlug.length > 63) {
		throw new Error("Collection deletion guard requires a valid collection slug");
	}
}
