/**
 * Database Adapter Functions
 *
 * These run at config time (astro.config.mjs) and return serializable descriptors.
 * The actual dialect is created at runtime by loading the entrypoint.
 *
 * @example
 * ```ts
 * // astro.config.mjs
 * import emdash from "emdash/astro";
 * import { sqlite } from "emdash/db";
 *
 * export default defineConfig({
 *   integrations: [
 *     emdash({
 *       database: sqlite({ url: "file:./data.db" }),
 *     }),
 *   ],
 * });
 * ```
 */

/**
 * Dialect family identifier.
 * Used at runtime to select dialect-specific SQL fragments.
 */
export type DatabaseDialectType = "sqlite" | "postgres";

/**
 * Database descriptor - serializable config for virtual modules
 */
export interface DatabaseDescriptor {
	entrypoint: string;
	config: unknown;
	type: DatabaseDialectType;
	/**
	 * When true, the adapter's runtime entrypoint MUST export a named
	 * `createRequestScopedDb` function matching the signature declared in
	 * `virtual:emdash/dialect`. The virtual-module generator re-exports it
	 * by name, so a missing export becomes a build-time bundler error.
	 *
	 * The function is called once per request and decides — based on its own
	 * runtime config (e.g. whether the user opted into D1 sessions) — whether
	 * to return a per-request Kysely or null. Use this for features like D1
	 * read-replica sessions, bookmark cookies, or any per-request DB handle.
	 *
	 * When false or absent, the generator emits a stub that returns null and
	 * the middleware takes its default (singleton) path.
	 */
	supportsRequestScope?: boolean;
}

export interface SqliteConfig {
	/**
	 * Database URL (e.g., "file:./data.db")
	 */
	url: string;
}

export interface LibsqlConfig {
	/**
	 * Database URL (e.g., "file:./data.db" or "libsql://...")
	 */
	url: string;
	/**
	 * Auth token for remote libSQL
	 */
	authToken?: string;
}

/**
 * SQLite database adapter (better-sqlite3)
 *
 * For local development and Node.js deployments.
 *
 * @example
 * ```ts
 * database: sqlite({ url: "file:./data.db" })
 * ```
 */
export function sqlite(config: SqliteConfig): DatabaseDescriptor {
	return {
		entrypoint: "emdash/db/sqlite",
		config,
		type: "sqlite",
	};
}

/**
 * libSQL database adapter (Turso)
 *
 * For Turso hosted databases or local libSQL.
 *
 * @example
 * ```ts
 * database: libsql({
 *   url: "libsql://my-db.turso.io",
 *   authToken: process.env.TURSO_AUTH_TOKEN,
 * })
 * ```
 */
export function libsql(config: LibsqlConfig): DatabaseDescriptor {
	return {
		entrypoint: "emdash/db/libsql",
		config,
		type: "sqlite",
	};
}

/**
 * PostgreSQL connection configuration
 */
export interface PostgresConfig {
	connectionString?: string;
	host?: string;
	port?: number;
	database?: string;
	user?: string;
	password?: string;
	ssl?: boolean;
	pool?: { min?: number; max?: number };
}

/**
 * PostgreSQL database adapter
 *
 * For PostgreSQL deployments with connection pooling.
 *
 * @example
 * ```ts
 * database: postgres({ connectionString: process.env.DATABASE_URL })
 * ```
 */
export function postgres(config: PostgresConfig): DatabaseDescriptor {
	return {
		entrypoint: "emdash/db/postgres",
		config,
		type: "postgres",
	};
}
