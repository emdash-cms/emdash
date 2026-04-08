/**
 * Cloudflare D1 runtime adapter - RUNTIME ENTRY
 *
 * Creates a Kysely dialect for D1.
 * Loaded at runtime via virtual module when database queries are needed.
 *
 * This module imports directly from cloudflare:workers to access the D1 binding.
 * Do NOT import this at config time - use { d1 } from "@emdash-cms/cloudflare" instead.
 */

import { env } from "cloudflare:workers";
import type { DatabaseIntrospector, Dialect, Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { wrapWithLazyMigrations } from "emdash/db/lazy-migrations";

import { D1Introspector } from "./d1-introspector.js";

/**
 * D1 configuration (runtime type — matches the config-time type in index.ts)
 */
interface D1Config {
	binding: string;
	session?: "disabled" | "auto" | "primary-first";
	bookmarkCookie?: string;
}

/**
 * Custom D1 Dialect that uses our D1-compatible introspector
 *
 * The default kysely-d1 dialect uses SqliteIntrospector which does a
 * cross-join with pragma_table_info() that D1 doesn't allow.
 */
class EmDashD1Dialect extends D1Dialect {
	override createIntrospector(db: Kysely<any>): DatabaseIntrospector {
		return new D1Introspector(db);
	}
}

/**
 * Create a D1 dialect from config
 *
 * @param config - D1 configuration with binding name
 */
export function createDialect(config: D1Config): Dialect {
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Worker binding accessed from untyped env object
	const db = (env as Record<string, unknown>)[config.binding];

	if (!db) {
		throw new Error(
			`D1 binding "${config.binding}" not found in environment. ` +
				`Check your wrangler.toml configuration:\n\n` +
				`[[d1_databases]]\n` +
				`binding = "${config.binding}"\n` +
				`database_name = "your-database-name"\n` +
				`database_id = "your-database-id"`,
		);
	}

	// Use our custom dialect with D1-compatible introspector
	// db is unknown from env access; D1Dialect expects D1Database
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- D1Database binding from untyped env object
	const dialect = new EmDashD1Dialect({ database: db as D1Database });

	// Wrap with lazy migration retry — migrations only run on first schema
	// error instead of checking 30+ migrations on every cold start
	return wrapWithLazyMigrations(dialect);
}

// =========================================================================
// D1 Read Replica Session Helpers
//
// These are exported through virtual:emdash/dialect so the middleware
// can create per-request D1 sessions without importing cloudflare:workers.
// =========================================================================

/**
 * Whether D1 sessions are enabled in the config.
 */
export function isSessionEnabled(config: D1Config): boolean {
	return !!config.session && config.session !== "disabled";
}

/**
 * Get the raw D1 binding for creating sessions.
 * Returns null if sessions are disabled.
 */
export function getD1Binding(config: D1Config): D1Database | null {
	if (!isSessionEnabled(config)) return null;
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Worker binding accessed from untyped env object
	const db = (env as Record<string, unknown>)[config.binding] as D1Database | undefined;
	return db ?? null;
}

/**
 * Get the default session constraint for the config's session mode.
 */
export function getDefaultConstraint(config: D1Config): string {
	if (config.session === "primary-first") return "first-primary";
	return "first-unconstrained";
}

/**
 * Get the cookie name used for storing D1 session bookmarks.
 */
export function getBookmarkCookieName(config: D1Config): string {
	return config.bookmarkCookie ?? "__ec_d1_bookmark";
}

/**
 * Create a Kysely dialect from a D1 session object.
 *
 * D1DatabaseSession has the same `prepare()` / `batch()` interface
 * as D1Database, so we pass it directly to D1Dialect.
 */
export function createSessionDialect(session: D1Database): Dialect {
	return new EmDashD1Dialect({ database: session });
}
