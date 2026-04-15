import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import type { Database } from "./types.js";

export interface DatabaseConfig {
	url: string;
	authToken?: string;
}

export class EmDashDatabaseError extends Error {
	constructor(
		message: string,
		public override cause?: unknown,
	) {
		super(message);
		this.name = "EmDashDatabaseError";
	}
}

/**
 * Returns a helpful, actionable message when better-sqlite3's native binary
 * was compiled against a different Node.js version than the one running. This
 * happens after upgrading Node without rebuilding native deps.
 *
 * Returns null if the error is not a NODE_MODULE_VERSION mismatch.
 */
export function formatNativeModuleVersionError(error: unknown): string | null {
	const message = error instanceof Error ? error.message : String(error);
	if (!message.includes("NODE_MODULE_VERSION")) return null;
	return (
		"better-sqlite3's native binary was compiled against a different Node.js version. " +
		"Rebuild it with `pnpm rebuild better-sqlite3` (or `npm rebuild better-sqlite3`), " +
		"or reinstall dependencies with your current Node.js version."
	);
}

/**
 * Creates a Kysely database instance
 * Supports:
 * - file:./path/to/db.sqlite (local SQLite)
 * - :memory: (in-memory SQLite for testing)
 * - libsql://... (Turso/libSQL with auth token) - TODO
 */
export function createDatabase(config: DatabaseConfig): Kysely<Database> {
	try {
		// Handle file-based SQLite
		if (config.url.startsWith("file:") || config.url === ":memory:") {
			const dbPath = config.url === ":memory:" ? ":memory:" : config.url.replace("file:", "");

			const sqlite = new BetterSqlite3(dbPath);

			// Enable WAL mode for crash safety — writes go to a write-ahead log
			// before being applied, preventing FTS5 shadow table corruption on
			// process kill during content writes. No-op for :memory: databases.
			sqlite.pragma("journal_mode = WAL");

			// Enable foreign key constraints
			sqlite.pragma("foreign_keys = ON");

			const dialect = new SqliteDialect({
				database: sqlite,
			});

			return new Kysely<Database>({ dialect });
		}

		// Handle libSQL (Turso)
		if (config.url.startsWith("libsql:")) {
			if (!config.authToken) {
				throw new EmDashDatabaseError("Auth token required for remote libSQL database");
			}
			// LibSQL implementation would use @libsql/kysely-libsql
			throw new EmDashDatabaseError("LibSQL not yet implemented");
		}

		throw new EmDashDatabaseError(`Unsupported database URL scheme: ${config.url}`);
	} catch (error) {
		if (error instanceof EmDashDatabaseError) {
			throw error;
		}
		const nativeVersionHint = formatNativeModuleVersionError(error);
		if (nativeVersionHint) {
			throw new EmDashDatabaseError(nativeVersionHint, error);
		}
		throw new EmDashDatabaseError("Failed to create database", error);
	}
}
