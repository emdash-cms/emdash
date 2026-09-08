/**
 * PostgreSQL runtime adapter
 *
 * Creates a Kysely dialect for PostgreSQL via pg.
 * Loaded at runtime via virtual module.
 */

import type { PostgresDialect } from "kysely";
import { Pool } from "pg";

import { FailFastPostgresDialect } from "../database/pg-migration-lock.js";
import type { PostgresConfig } from "./adapters.js";

const URL_PATTERN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g;
const CREDENTIAL_PATTERN = /\b(auth|credential|key|password|secret|signature|token)\s*[=:]\s*\S+/gi;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

function redactPoolErrorMessage(message: string): string {
	return message
		.replace(URL_PATTERN, "[REDACTED_URL]")
		.replace(CREDENTIAL_PATTERN, "$1=[REDACTED]")
		.replaceAll(/[\r\n\t]/g, " ")
		.slice(0, 1_000);
}

function logPoolError(error: Error): void {
	// pg attaches the failed client to this error, which can contain connection credentials.
	const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
	const safeCode = code && ERROR_CODE_PATTERN.test(code) ? ` (${code})` : "";
	const message = redactPoolErrorMessage(error.message) || "Unknown error";
	console.error(`[emdash] PostgreSQL idle client error${safeCode}: ${message}`);
}

/**
 * Create a PostgreSQL dialect from config
 */
export function createDialect(config: PostgresConfig): PostgresDialect {
	const pool = new Pool({
		connectionString: config.connectionString,
		host: config.host,
		port: config.port,
		database: config.database,
		user: config.user,
		password: config.password,
		ssl: config.ssl,
		min: config.pool?.min ?? 0,
		max: config.pool?.max ?? 10,
		connectionTimeoutMillis: config.pool?.connectionTimeoutMillis,
		idleTimeoutMillis: config.pool?.idleTimeoutMillis,
	});
	pool.on("error", logPoolError);

	// Fail-fast migration locking instead of Kysely's blocking advisory
	// lock — see pg-migration-lock.ts (#1744).
	return new FailFastPostgresDialect({ pool });
}
