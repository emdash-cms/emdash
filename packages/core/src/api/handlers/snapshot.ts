/**
 * Snapshot handler — generates a portable database snapshot.
 *
 * Returns all content tables, schema definitions, and supporting data
 * needed to render content in an isolated preview database.
 *
 * Used by:
 * - DO preview database (EmDashPreviewDB.populateFromSnapshot)
 * - Future: CLI export, backup, site migration
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";

import { listTableColumns, listTablesLike } from "../../database/dialect-helpers.js";
import type { Database } from "../../database/types.js";

// ─�� Preview signature verification ──────────────────────────────

/**
 * Verify HMAC-SHA256 preview signature using crypto.subtle.
 * Returns true if the signature is valid and not expired.
 */
export async function verifyPreviewSignature(
	source: string,
	exp: number,
	sig: string,
	secret: string,
): Promise<boolean> {
	if (exp < Date.now() / 1000) return false;

	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);

	const sigBytes = new Uint8Array(sig.length / 2);
	for (let i = 0; i < sig.length; i += 2) {
		sigBytes[i / 2] = parseInt(sig.substring(i, i + 2), 16);
	}

	return crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(`${source}:${exp}`));
}

/**
 * Parse an X-Preview-Signature header value into its components.
 *
 * Format: "source:exp:sig" where source is a URL (contains colons),
 * exp is a unix timestamp, and sig is 64 hex chars.
 *
 * Parses from the right since source URLs contain colons.
 *
 * @returns Parsed components, or null if the format is invalid
 */
export function parsePreviewSignatureHeader(
	header: string,
): { source: string; exp: number; sig: string } | null {
	const lastColon = header.lastIndexOf(":");
	if (lastColon <= 0) return null;

	const sig = header.substring(lastColon + 1);
	if (sig.length !== 64) return null;

	const rest = header.substring(0, lastColon);
	const secondLastColon = rest.lastIndexOf(":");
	if (secondLastColon <= 0) return null;

	const source = rest.substring(0, secondLastColon);
	const exp = parseInt(rest.substring(secondLastColon + 1), 10);

	if (isNaN(exp) || source.length === 0) return null;

	return { source, exp, sig };
}

// ── Media URL rewriting ─────────────────────────────────────────

const MEDIA_FILE_PREFIX = "/_emdash/api/media/file/";

/**
 * Parse a JSON string value and inject `src` for local media objects.
 * Returns the original string if it's not a local media value.
 */
function injectMediaSrc(jsonStr: string, origin: string): string {
	try {
		const obj = JSON.parse(jsonStr);
		if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return jsonStr;
		if (injectMediaSrcInto(obj, origin)) {
			return JSON.stringify(obj);
		}
		return jsonStr;
	} catch {
		return jsonStr;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively walk an object and inject `src` into local media values.
 * Returns true if any modifications were made.
 */
function injectMediaSrcInto(obj: Record<string, unknown>, origin: string): boolean {
	let modified = false;

	// Check if this object itself is a local media value
	if ((obj.provider === "local" || (!obj.provider && obj.id && obj.meta)) && !obj.src) {
		const meta = isRecord(obj.meta) ? obj.meta : undefined;
		const storageKey = meta?.storageKey ?? obj.id;
		if (typeof storageKey === "string" && storageKey) {
			obj.src = `${origin}${MEDIA_FILE_PREFIX}${storageKey}`;
			modified = true;
		}
	}

	// Recurse into nested objects/arrays (e.g. Portable Text with image blocks)
	for (const value of Object.values(obj)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				if (isRecord(item)) {
					if (injectMediaSrcInto(item, origin)) {
						modified = true;
					}
				}
			}
		} else if (isRecord(value)) {
			if (injectMediaSrcInto(value, origin)) {
				modified = true;
			}
		}
	}

	return modified;
}

// ── Snapshot generation ─────────────────────────────────────────

/**
 * Safe identifier pattern for snapshot table names.
 * More permissive than validateIdentifier() — allows leading underscores
 * (needed for system tables like _emdash_collections).
 */
const SAFE_TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

/** Snapshot shape consumed by the DO preview database */
export interface Snapshot {
	tables: Record<string, Record<string, unknown>[]>;
	schema: Record<
		string,
		{
			columns: string[];
			types?: Record<string, string>;
		}
	>;
	generatedAt: string;
}

/**
 * System tables included in snapshots.
 * Content tables (ec_*) are discovered dynamically.
 */
const SYSTEM_TABLES = [
	"_emdash_collections",
	"_emdash_fields",
	"_emdash_taxonomy_defs",
	"_emdash_menus",
	"_emdash_menu_items",
	"_emdash_sections",
	"_emdash_widget_areas",
	"_emdash_widgets",
	"_emdash_seo",
	"_emdash_migrations",
	"taxonomies",
	"content_taxonomies",
	"media",
	"options",
	"revisions",
];

/**
 * Table name prefixes excluded from snapshots (auth/security data).
 */
const EXCLUDED_PREFIXES = [
	"_emdash_api_tokens",
	"_emdash_oauth_tokens",
	"_emdash_authorization_codes",
	"_emdash_device_codes",
	"_emdash_migrations_lock",
	"_plugin_",
	"users",
	"sessions",
	"credentials",
	"challenges",
];

/**
 * Options key prefixes safe for inclusion in snapshots.
 *
 * The options table contains plugin secrets (plugin:*), passkey challenges
 * (emdash:passkey_pending:*), and setup state that must not leak to
 * preview databases. Only site-level rendering settings are needed.
 */
const SAFE_OPTIONS_PREFIXES = ["site:"];

function isExcluded(tableName: string): boolean {
	return EXCLUDED_PREFIXES.some((prefix) => tableName.startsWith(prefix));
}

type SnapshotColumnType = "TEXT" | "INTEGER" | "REAL" | "BLOB" | "JSON";

function normalizeColumnType(type: string): SnapshotColumnType {
	switch (type.toLowerCase()) {
		case "smallint":
		case "integer":
		case "bigint":
		case "boolean":
			return "INTEGER";
		case "real":
		case "double precision":
		case "numeric":
		case "decimal":
			return "REAL";
		case "blob":
		case "bytea":
			return "BLOB";
		case "json":
		case "jsonb":
			return "JSON";
		default:
			return "TEXT";
	}
}

function normalizeRows(
	rows: Record<string, unknown>[],
	types: Record<string, SnapshotColumnType>,
): Record<string, unknown>[] {
	for (const row of rows) {
		for (const [column, type] of Object.entries(types)) {
			const value = row[column];
			if (type === "JSON" && value !== null && value !== undefined && typeof value !== "string") {
				row[column] = JSON.stringify(value);
			}
		}
	}
	return rows;
}

export interface GenerateSnapshotOptions {
	/** Include draft and scheduled content (default: false) */
	includeDrafts?: boolean;
	/** Include trashed content (deleted_at set). Used by backups (default: false) */
	includeTrashed?: boolean;
	/** Origin URL for absolutizing local media URLs (e.g. "https://mysite.com") */
	origin?: string;
	/**
	 * Allowlist of options-table key prefixes to include (default:
	 * `SAFE_OPTIONS_PREFIXES`). Callers widening this must never include a
	 * prefix that matches secrets (`emdash:preview_secret`, `plugin:`,
	 * `emdash:passkey_pending:`) — the output may be user-downloadable.
	 */
	optionPrefixes?: string[];
}

/**
 * Generate a portable database snapshot.
 *
 * Discovers ec_* content tables dynamically, exports system tables
 * needed for rendering, and includes schema info for table recreation.
 */
export async function generateSnapshot(
	db: Kysely<Database>,
	options?: GenerateSnapshotOptions,
): Promise<Snapshot> {
	const includeDrafts = options?.includeDrafts ?? false;
	const includeTrashed = options?.includeTrashed ?? false;
	const optionPrefixes = options?.optionPrefixes ?? SAFE_OPTIONS_PREFIXES;

	const contentTables = await listTablesLike(db, "ec_%");

	// Build list of all tables to export
	const allTables = [...contentTables, ...SYSTEM_TABLES];

	const tables: Record<string, Record<string, unknown>[]> = {};
	const schema: Record<string, { columns: string[]; types?: Record<string, string> }> = {};

	for (const tableName of allTables) {
		if (isExcluded(tableName)) continue;

		// Content table names come from the database catalog. Validate them
		// before passing them to sql.ref().
		if (!SAFE_TABLE_NAME.test(tableName)) continue;

		const columnInfo = await listTableColumns(db, tableName);
		if (columnInfo.length === 0) continue;

		const columns = columnInfo.map((column) => column.name);
		const types: Record<string, SnapshotColumnType> = {};
		for (const column of columnInfo) {
			types[column.name] = normalizeColumnType(column.type);
		}

		schema[tableName] = { columns, types };

		let rows: Record<string, unknown>[];

		if (tableName.startsWith("ec_")) {
			if (includeTrashed) {
				rows = (
					await sql<Record<string, unknown>>`
						SELECT * FROM ${sql.ref(tableName)}
					`.execute(db)
				).rows;
			} else if (includeDrafts) {
				rows = (
					await sql<Record<string, unknown>>`
						SELECT * FROM ${sql.ref(tableName)}
						WHERE deleted_at IS NULL
					`.execute(db)
				).rows;
			} else {
				rows = (
					await sql<Record<string, unknown>>`
						SELECT * FROM ${sql.ref(tableName)}
						WHERE deleted_at IS NULL
						AND status = 'published'
					`.execute(db)
				).rows;
			}
		} else if (tableName === "options") {
			rows = (
				await sql<Record<string, unknown>>`
					SELECT * FROM ${sql.ref(tableName)}
				`.execute(db)
			).rows.filter((row) => {
				const name = typeof row.name === "string" ? row.name : "";
				return optionPrefixes.some((prefix) => name.startsWith(prefix));
			});
		} else {
			rows = (
				await sql<Record<string, unknown>>`
					SELECT * FROM ${sql.ref(tableName)}
				`.execute(db)
			).rows;
		}

		if (rows.length > 0) {
			tables[tableName] = normalizeRows(rows, types);
		}
	}

	// Absolutize local media URLs in content tables so snapshots are portable.
	// Local image fields are stored as JSON with provider:"local" and
	// meta.storageKey but no src — the URL is derived at render time.
	// For snapshots consumed by external preview services, inject src now.
	if (options?.origin) {
		const origin = options.origin;
		for (const [tableName, rows] of Object.entries(tables)) {
			if (!tableName.startsWith("ec_")) continue;
			for (const row of rows) {
				for (const [col, value] of Object.entries(row)) {
					if (typeof value !== "string" || !value.startsWith("{")) continue;
					row[col] = injectMediaSrc(value, origin);
				}
			}
		}
	}

	return {
		tables,
		schema,
		generatedAt: new Date().toISOString(),
	};
}
