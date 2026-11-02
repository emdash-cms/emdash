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
const MEDIA_FILE_SUFFIX = /[?#]/;
const EXTERNAL_OR_ROOT_URL = /^(?:[a-z][a-z0-9+.-]*:|\/)/i;

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
	"_emdash_block_types",
	"_emdash_block_type_versions",
	"_emdash_collections",
	"_emdash_fields",
	"_emdash_taxonomy_defs",
	"_emdash_taxonomy_def_groups",
	"_emdash_menus",
	"_emdash_menu_items",
	"_emdash_sections",
	"_emdash_widget_areas",
	"_emdash_widgets",
	"_emdash_seo",
	"_emdash_migrations",
	"content_taxonomies",
	"taxonomies",
	"options",
	"media",
	"revisions",
] as const;

type SystemTable = (typeof SYSTEM_TABLES)[number];
type PublishedTablePolicy = "full" | "content-linked" | "omit";

/**
 * Published snapshots are available to preview-signature callers, so every
 * system table must be classified explicitly. Adding a snapshot table without
 * choosing a policy is a type error rather than an accidental data export.
 */
const PUBLISHED_TABLE_POLICIES: Record<SystemTable, PublishedTablePolicy> = {
	_emdash_block_types: "full",
	_emdash_block_type_versions: "full",
	_emdash_collections: "full",
	_emdash_fields: "full",
	_emdash_taxonomy_defs: "full",
	_emdash_taxonomy_def_groups: "full",
	_emdash_menus: "full",
	_emdash_menu_items: "content-linked",
	_emdash_sections: "full",
	_emdash_widget_areas: "full",
	_emdash_widgets: "full",
	_emdash_seo: "content-linked",
	_emdash_migrations: "full",
	content_taxonomies: "content-linked",
	taxonomies: "content-linked",
	options: "content-linked",
	media: "content-linked",
	revisions: "omit",
};

const SYSTEM_TABLE_SET: ReadonlySet<string> = new Set(SYSTEM_TABLES);

function isSystemTable(tableName: string): tableName is SystemTable {
	return SYSTEM_TABLE_SET.has(tableName);
}

interface PublishedContentReferences {
	ids: Set<string>;
	translationGroups: Set<string>;
}

interface PublishedProjection {
	content: Map<string, PublishedContentReferences>;
	taxonomyGroups: Set<string>;
	mediaIds: Set<string>;
	mediaStorageKeys: Set<string>;
}

/**
 * Table name prefixes excluded from snapshots (auth/security data).
 */
const EXCLUDED_PREFIXES = [
	"_emdash_api_tokens",
	"_emdash_oauth_tokens",
	"_emdash_authorization_codes",
	"_emdash_device_codes",
	"_emdash_migrations_lock",
	"_emdash_transfer_",
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

function createPublishedProjection(): PublishedProjection {
	return {
		content: new Map(),
		taxonomyGroups: new Set(),
		mediaIds: new Set(),
		mediaStorageKeys: new Set(),
	};
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function recordPublishedContent(
	projection: PublishedProjection,
	tableName: string,
	rows: Record<string, unknown>[],
): void {
	const references: PublishedContentReferences = {
		ids: new Set(),
		translationGroups: new Set(),
	};
	for (const row of rows) {
		const id = readString(row.id);
		const translationGroup = readString(row.translation_group);
		if (id) references.ids.add(id);
		if (translationGroup) references.translationGroups.add(translationGroup);
	}
	projection.content.set(tableName.slice("ec_".length), references);
}

function isPublishedContentReference(
	projection: PublishedProjection,
	collection: unknown,
	reference: unknown,
): boolean {
	const collectionName = readString(collection);
	const id = readString(reference);
	if (!collectionName || !id) return false;
	const references = projection.content.get(collectionName);
	return references?.ids.has(id) === true || references?.translationGroups.has(id) === true;
}

function collectMediaReferences(value: unknown, projection: PublishedProjection): void {
	if (typeof value === "string") {
		if (value.startsWith(MEDIA_FILE_PREFIX)) {
			const storageKey = value.slice(MEDIA_FILE_PREFIX.length).split(MEDIA_FILE_SUFFIX, 1)[0];
			if (storageKey) projection.mediaStorageKeys.add(storageKey);
			return;
		}
		const trimmed = value.trimStart();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				collectMediaReferences(JSON.parse(value), projection);
			} catch {
				// Not structured data.
			}
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectMediaReferences(item, projection);
		return;
	}
	if (!isRecord(value)) return;

	const mediaId = readString(value.mediaId);
	if (mediaId) projection.mediaIds.add(mediaId);

	const provider = readString(value.provider);
	const meta = isRecord(value.meta) ? value.meta : null;
	const localMediaId = readString(value.id);
	if ((provider === "local" || (!provider && meta)) && localMediaId) {
		projection.mediaIds.add(localMediaId);
	}
	const storageKey = readString(value.storageKey) ?? readString(meta?.storageKey);
	if (storageKey) projection.mediaStorageKeys.add(storageKey);

	const asset = isRecord(value.asset) ? value.asset : null;
	const assetRef = readString(asset?._ref);
	if (assetRef) {
		projection.mediaIds.add(assetRef);
		projection.mediaStorageKeys.add(assetRef);
	}

	for (const child of Object.values(value)) collectMediaReferences(child, projection);
}

function projectTaxonomyRows(
	rows: Record<string, unknown>[],
	projection: PublishedProjection,
): Record<string, unknown>[] {
	const includedGroups = new Set(projection.taxonomyGroups);
	const includedIds = new Set(projection.taxonomyGroups);
	let changed = true;
	while (changed) {
		changed = false;
		for (const row of rows) {
			const id = readString(row.id);
			const group = readString(row.translation_group);
			if (!id) continue;
			if (includedIds.has(id) || (group && includedGroups.has(group))) {
				if (!includedIds.has(id)) {
					includedIds.add(id);
					changed = true;
				}
				if (group && !includedGroups.has(group)) {
					includedGroups.add(group);
					changed = true;
				}
				const parentId = readString(row.parent_id);
				if (parentId && !includedIds.has(parentId)) {
					includedIds.add(parentId);
					changed = true;
				}
			}
		}
	}
	return rows.filter((row) => {
		const id = readString(row.id);
		const group = readString(row.translation_group);
		return (id && includedIds.has(id)) || (group && includedGroups.has(group));
	});
}

function projectPublishedRows(
	tableName: SystemTable,
	rows: Record<string, unknown>[],
	projection: PublishedProjection,
): Record<string, unknown>[] {
	switch (tableName) {
		case "_emdash_seo":
			return rows.filter((row) => {
				const published = isPublishedContentReference(projection, row.collection, row.content_id);
				if (!published) return false;
				const image = readString(row.seo_image);
				if (image) {
					collectMediaReferences(image, projection);
					if (!EXTERNAL_OR_ROOT_URL.test(image)) {
						projection.mediaIds.add(image);
						projection.mediaStorageKeys.add(image);
					}
				}
				return true;
			});
		case "content_taxonomies":
			return rows.filter((row) => {
				const published = isPublishedContentReference(projection, row.collection, row.entry_id);
				const taxonomyGroup = readString(row.taxonomy_id);
				if (published && taxonomyGroup) projection.taxonomyGroups.add(taxonomyGroup);
				return published;
			});
		case "taxonomies":
			return projectTaxonomyRows(rows, projection);
		case "_emdash_menu_items":
			return rows.filter((row) => {
				const type = readString(row.type);
				const referenceId = readString(row.reference_id);
				if (!referenceId || type === "custom") return true;
				if (type === "taxonomy") {
					projection.taxonomyGroups.add(referenceId);
					return true;
				}
				if (type === "collection" && !row.reference_id) return true;
				const collection =
					readString(row.reference_collection) ??
					(type === "post" || type === "page" ? `${type}s` : null);
				return isPublishedContentReference(projection, collection, referenceId);
			});
		case "media":
			return rows.filter((row) => {
				const id = readString(row.id);
				const storageKey = readString(row.storage_key);
				return (
					(id !== null && projection.mediaIds.has(id)) ||
					(storageKey !== null && projection.mediaStorageKeys.has(storageKey))
				);
			});
		case "options":
			return rows;
		default:
			return [];
	}
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
	/** Exact options-table keys to include in addition to `optionPrefixes`. */
	optionKeys?: string[];
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
	const optionKeys = new Set(options?.optionKeys);
	const publishedOnly = !includeDrafts && !includeTrashed;
	const publishedProjection = createPublishedProjection();

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
		} else if (
			publishedOnly &&
			isSystemTable(tableName) &&
			PUBLISHED_TABLE_POLICIES[tableName] === "omit"
		) {
			rows = [];
		} else if (tableName === "options") {
			rows = (
				await sql<Record<string, unknown>>`
					SELECT * FROM ${sql.ref(tableName)}
				`.execute(db)
			).rows.filter((row) => {
				const name = typeof row.name === "string" ? row.name : "";
				return optionKeys.has(name) || optionPrefixes.some((prefix) => name.startsWith(prefix));
			});
		} else {
			rows = (
				await sql<Record<string, unknown>>`
					SELECT * FROM ${sql.ref(tableName)}
				`.execute(db)
			).rows;
		}

		if (publishedOnly) {
			if (tableName.startsWith("ec_")) {
				recordPublishedContent(publishedProjection, tableName, rows);
			} else if (
				isSystemTable(tableName) &&
				PUBLISHED_TABLE_POLICIES[tableName] === "content-linked"
			) {
				rows = projectPublishedRows(tableName, rows, publishedProjection);
			}
			for (const row of rows) collectMediaReferences(row, publishedProjection);
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
