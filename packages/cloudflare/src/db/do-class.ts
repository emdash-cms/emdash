/**
 * EmDashPreviewDB — Durable Object for preview databases
 *
 * Each preview session gets its own DO with isolated SQLite storage.
 * The DO is populated from a snapshot of the source EmDash site
 * and serves read-only queries until its TTL expires.
 *
 * Not used in production — preview only.
 */

import { DurableObject } from "cloudflare:workers";

/** Default TTL for preview data (1 hour) */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** Valid identifier pattern for snapshot table/column names */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** SQL command prefixes that indicate read-only statements */
const READ_PREFIXES = ["SELECT", "PRAGMA", "EXPLAIN", "WITH"];

/** Result shape returned by query() */
export interface QueryResult {
	rows: Record<string, unknown>[];
	/** Number of rows written. Undefined for read-only queries. */
	changes?: number;
}

/** A single statement for batch execution */
export interface BatchStatement {
	sql: string;
	params?: unknown[];
}

/** Snapshot shape received from the source site */
interface Snapshot {
	tables: Record<string, Record<string, unknown>[]>;
	schema?: Record<
		string,
		{
			columns: string[];
			types?: Record<string, string>;
		}
	>;
	generatedAt: string;
}

export class EmDashPreviewDB extends DurableObject {
	/**
	 * Execute a single SQL statement.
	 *
	 * Called via RPC from the Kysely driver connection.
	 */
	query(sql: string, params?: unknown[]): QueryResult {
		const cursor = params?.length
			? this.ctx.storage.sql.exec(sql, ...params)
			: this.ctx.storage.sql.exec(sql);

		const rows: Record<string, unknown>[] = [];
		for (const row of cursor) {
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- SqlStorageCursor yields record-like objects
			rows.push(row as Record<string, unknown>);
		}

		const isRead = READ_PREFIXES.some((p) => sql.trimStart().toUpperCase().startsWith(p));

		return {
			rows,
			changes: isRead ? undefined : cursor.rowsWritten,
		};
	}

	/**
	 * Execute multiple statements in a single synchronous transaction.
	 *
	 * Used for snapshot import.
	 */
	batch(statements: BatchStatement[]): void {
		this.ctx.storage.transactionSync(() => {
			for (const stmt of statements) {
				if (stmt.params?.length) {
					this.ctx.storage.sql.exec(stmt.sql, ...stmt.params);
				} else {
					this.ctx.storage.sql.exec(stmt.sql);
				}
			}
		});
	}

	/**
	 * Invalidate the cached snapshot so the next populateFromSnapshot call
	 * re-fetches from the source site.
	 */
	invalidateSnapshot(): void {
		try {
			this.ctx.storage.sql.exec("DELETE FROM _emdash_do_meta WHERE key = 'snapshot_fetched_at'");
		} catch {
			// Table doesn't exist — nothing to invalidate
		}
	}

	/**
	 * Get snapshot metadata (generated-at timestamp).
	 * Returns null if the DO has no snapshot loaded.
	 */
	getSnapshotMeta(): { generatedAt: string } | null {
		try {
			const row = this.ctx.storage.sql
				.exec("SELECT value FROM _emdash_do_meta WHERE key = 'snapshot_generated_at'")
				.one();
			const value = row.value;
			if (typeof value !== "string") return null;
			return { generatedAt: value };
		} catch {
			return null;
		}
	}

	/**
	 * Populate from a snapshot (preview mode).
	 *
	 * Fetches content from a source EmDash site and loads it into
	 * this DO's SQLite. Sets a TTL alarm for cleanup.
	 */
	async populateFromSnapshot(
		sourceUrl: string,
		signature: string,
		options?: { drafts?: boolean; ttl?: number },
	): Promise<{ generatedAt: string }> {
		const ttlMs = (options?.ttl ?? DEFAULT_TTL_MS / 1000) * 1000;

		// Check if already populated and fresh
		try {
			const meta = this.ctx.storage.sql
				.exec("SELECT value FROM _emdash_do_meta WHERE key = 'snapshot_fetched_at'")
				.one();
			const fetchedAt = Number(meta.value);
			if (Date.now() - fetchedAt < ttlMs) {
				// Refresh alarm so active sessions aren't killed
				void this.ctx.storage.setAlarm(Date.now() + ttlMs);
				const gen = this.ctx.storage.sql
					.exec("SELECT value FROM _emdash_do_meta WHERE key = 'snapshot_generated_at'")
					.one();
				// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- SqlStorageCursor yields loosely-typed rows
				return { generatedAt: String(gen.value as string | number) };
			}
		} catch (error) {
			// Only swallow "no such table" — surface all other errors
			if (!(error instanceof Error) || !error.message.includes("no such table")) {
				throw error;
			}
			// _emdash_do_meta doesn't exist yet — first population
		}

		// Fetch snapshot with timeout
		const url = `${sourceUrl}/_emdash/api/snapshot${options?.drafts ? "?drafts=true" : ""}`;
		const response = await fetch(url, {
			headers: { "X-Preview-Signature": signature },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(
				`Snapshot fetch failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
			);
		}
		const snapshot: Snapshot = await response.json();

		// Wipe and repopulate in a single transaction so partial applies
		// can't leave the database in an inconsistent state.
		// ctx.storage.deleteAll() only clears KV storage, not SQLite.
		this.ctx.storage.transactionSync(() => {
			this.dropAllTables();
			this.applySnapshot(snapshot);
		});

		// Set cleanup alarm
		void this.ctx.storage.setAlarm(Date.now() + ttlMs);

		return { generatedAt: snapshot.generatedAt };
	}

	/**
	 * Set a cleanup alarm after the given number of seconds.
	 *
	 * Used by the playground middleware to set TTL after initialization
	 * is complete (initialization runs on the Worker side via RPC).
	 */
	setTtlAlarm(ttlSeconds: number): void {
		void this.ctx.storage.setAlarm(Date.now() + ttlSeconds * 1000);
	}

	/**
	 * Alarm handler — clean up expired preview/playground data.
	 *
	 * Drops all user tables to reclaim storage.
	 */
	override alarm(): void {
		this.dropAllTables();
	}

	/**
	 * Drop all user tables in the DO's SQLite database.
	 * Preserves SQLite and Cloudflare internal tables.
	 *
	 * Disables foreign key enforcement before dropping to avoid cascade
	 * errors when tables are dropped in an order that violates FK
	 * dependencies (e.g. parent before child).
	 */
	private dropAllTables(): void {
		// Disable FK enforcement so DROP order doesn't matter.
		// Cloudflare DO SQLite enforces foreign keys by default.
		this.ctx.storage.sql.exec("PRAGMA foreign_keys = OFF");

		try {
			const tables = [
				...this.ctx.storage.sql.exec(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
				),
			];
			for (const row of tables) {
				// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- SqlStorageCursor yields loosely-typed rows
				const name = String(row.name as string);
				if (!SAFE_IDENTIFIER.test(name)) {
					// Skip tables with unsafe names rather than interpolating them
					continue;
				}
				this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS "${name}"`);
			}
		} finally {
			this.ctx.storage.sql.exec("PRAGMA foreign_keys = ON");
		}
	}

	private applySnapshot(snapshot: Snapshot): void {
		const validateSnapshotIdentifier = (name: string, context: string) => {
			if (!SAFE_IDENTIFIER.test(name)) {
				throw new Error(`Invalid ${context} in snapshot: ${JSON.stringify(name)}`);
			}
		};

		// Create meta table
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS _emdash_do_meta (key TEXT PRIMARY KEY, value TEXT)
		`);

		// Create tables and insert data from snapshot
		for (const [tableName, rows] of Object.entries(snapshot.tables)) {
			if (tableName === "_emdash_do_meta") continue;
			if (!rows.length) continue;

			validateSnapshotIdentifier(tableName, "table name");

			const schemaInfo = snapshot.schema?.[tableName];
			const columns = schemaInfo?.columns ?? Object.keys(rows[0]!);
			columns.forEach((c) => validateSnapshotIdentifier(c, `column name in ${tableName}`));

			const colDefs = columns
				.map((c) => {
					const colType = schemaInfo?.types?.[c] ?? "TEXT";
					const safeType = ["TEXT", "INTEGER", "REAL", "BLOB", "JSON"].includes(
						colType.toUpperCase(),
					)
						? colType.toUpperCase()
						: "TEXT";
					return `"${c}" ${safeType}`;
				})
				.join(", ");
			this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs})`);

			// Batch insert
			const placeholders = columns.map(() => "?").join(", ");
			const insertSql = `INSERT INTO "${tableName}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`;
			for (const row of rows) {
				const values = columns.map((c) => row[c] ?? null);
				this.ctx.storage.sql.exec(insertSql, ...values);
			}
		}

		// Record metadata
		this.ctx.storage.sql.exec(
			`INSERT OR REPLACE INTO _emdash_do_meta VALUES ('snapshot_fetched_at', ?), ('snapshot_generated_at', ?)`,
			String(Date.now()),
			snapshot.generatedAt,
		);
	}
}
