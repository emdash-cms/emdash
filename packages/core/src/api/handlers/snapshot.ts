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

/** Column info from PRAGMA table_info */
interface ColumnInfo {
	name: string;
	type: string;
}

export interface GenerateSnapshotOptions {
	/** Include draft and trashed content (default: false) */
	includeDrafts?: boolean;
	/** Origin URL for absolutizing local media URLs (e.g. "https://mysite.com") */
	origin?: string;
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

	// Discover all ec_* content tables
	const tableResult = await sql<{ name: string }>`
		SELECT name FROM sqlite_master
		WHERE type = 'table'
		AND name LIKE 'ec_%'
		ORDER BY name
	`.execute(db);

	const contentTables = tableResult.rows.map((r) => r.name);

	// Build list of all tables to export
	const allTables = [...contentTables, ...SYSTEM_TABLES];

	const tables: Record<string, Record<string, unknown>[]> = {};
	const schema: Record<string, { columns: string[]; types?: Record<string, string> }> = {};

	for (const tableName of allTables) {
		if (isExcluded(tableName)) continue;

		// Validate identifier before interpolating into sql.raw().
		// SYSTEM_TABLES are hardcoded and safe, but ec_* names come from
		// sqlite_master and must be validated.
		if (!SAFE_TABLE_NAME.test(tableName)) continue;

		try {
			// Get column info via PRAGMA
			const pragmaResult = await sql<ColumnInfo>`
				PRAGMA table_info(${sql.raw(`"${tableName}"`)})
			`.execute(db);

			if (pragmaResult.rows.length === 0) continue;

			const columns = pragmaResult.rows.map((r) => r.name);
			const types: Record<string, string> = {};
			for (const row of pragmaResult.rows) {
				types[row.name] = row.type || "TEXT";
			}

			schema[tableName] = { columns, types };

			// Fetch rows
			let rows: Record<string, unknown>[];

			if (tableName.startsWith("ec_")) {
				if (includeDrafts) {
					// Include all non-deleted content (published, draft, scheduled)
					rows = (
						await sql<Record<string, unknown>>`
						SELECT * FROM ${sql.raw(`"${tableName}"`)}
						WHERE deleted_at IS NULL
					`.execute(db)
					).rows;
				} else {
					// Only export published content
					rows = (
						await sql<Record<string, unknown>>`
						SELECT * FROM ${sql.raw(`"${tableName}"`)}
						WHERE deleted_at IS NULL
						AND (status = 'published' OR (status = 'scheduled' AND scheduled_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
					`.execute(db)
					).rows;
				}
			} else if (tableName === "options") {
				// Filter options to safe rendering-only prefixes.
				// Excludes plugin secrets, passkey challenges, and setup state.
				rows = (
					await sql<Record<string, unknown>>`
					SELECT * FROM ${sql.raw(`"${tableName}"`)}
				`.execute(db)
				).rows.filter((row) => {
					const name = typeof row.name === "string" ? row.name : "";
					return SAFE_OPTIONS_PREFIXES.some((prefix) => name.startsWith(prefix));
				});
			} else {
				rows = (
					await sql<Record<string, unknown>>`
					SELECT * FROM ${sql.raw(`"${tableName}"`)}
				`.execute(db)
				).rows;
			}

			if (rows.length > 0) {
				tables[tableName] = rows;
			}
		} catch {
			// Table might not exist yet (e.g. pre-migration) — skip silently
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
