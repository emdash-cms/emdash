/**
 * Astro Live Collections loader for EmDash
 *
 * This loader implements the Astro LiveLoader interface to fetch content
 * at runtime from the database, enabling live editing without rebuilds.
 *
 * Architecture:
 * - Single `_emdash` Astro collection handles all content types
 * - Dialect comes from virtual module (configured in astro.config.mjs)
 * - Each content type maps to its own database table: ec_posts, ec_products, etc.
 * - `getEmDashCollection()` / `getEmDashEntry()` wrap Astro's live collection API
 */

import type { LiveLoader } from "astro/loaders";
import { Kysely, sql, type Dialect } from "kysely";

import { currentTimestampValue, isPostgres } from "./database/dialect-helpers.js";
import { kyselyLogOption } from "./database/instrumentation.js";
import { decodeCursor, encodeCursor } from "./database/repositories/types.js";
import { validateIdentifier } from "./database/validate.js";
import type { Database } from "./index.js";
import { getRequestContext } from "./request-context.js";
import { isMissingColumnError, isMissingTableError } from "./utils/db-errors.js";

const FIELD_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * SEO columns joined in from `_emdash_seo` on the single-entry path, mapped to
 * aliased result keys. SEO lives in a side table, so a LEFT JOIN folds it into
 * the entry load at zero extra query cost; the result is surfaced as a nested
 * `data.seo` object (see extractSeo) rather than flat fields.
 *
 * The `_emdash_` prefix on the aliases guarantees they can never collide with
 * a content field. Field slugs must match `/^[a-z][a-z0-9_]*$/`, so a user can
 * legitimately define a `seo_title` field; selecting the joined column under
 * its bare name would shadow that field in the result set and drop the user's
 * value. The prefix (illegal as a leading slug char) sidesteps this entirely.
 */
const SEO_COLUMN_ALIASES: Record<string, string> = {
	seo_title: "_emdash_seo_title",
	seo_description: "_emdash_seo_description",
	seo_image: "_emdash_seo_image",
	seo_canonical: "_emdash_seo_canonical",
	seo_no_index: "_emdash_seo_no_index",
};

/** Aliased SEO result keys — excluded from generic field mapping. */
const SEO_ALIAS_COLUMNS = Object.values(SEO_COLUMN_ALIASES);

/**
 * System columns excluded from entry.data
 * Note: slug is intentionally NOT excluded - it's useful as data.slug in templates
 */
const SYSTEM_COLUMNS = new Set([
	"id",
	// "slug" - kept in data for template access
	"status",
	"author_id",
	"primary_byline_id",
	"created_at",
	"updated_at",
	"published_at",
	"scheduled_at",
	"deleted_at",
	"version",
	"live_revision_id",
	"draft_revision_id",
	"locale",
	"translation_group",
	// Aliased SEO columns joined from _emdash_seo on the single-entry path.
	// Surfaced as a nested data.seo object (see extractSeo), never as flat
	// fields. The aliases are _emdash_-prefixed so they can't shadow a user
	// field named e.g. `seo_title`.
	...SEO_ALIAS_COLUMNS,
]);

/** Resolved SEO shape attached to `entry.data.seo`. Mirrors `ContentSeo`. */
interface EntrySeo {
	title: string | null;
	description: string | null;
	image: string | null;
	canonical: string | null;
	noIndex: boolean;
}

/**
 * Build a `data.seo` object from the joined `_emdash_seo` columns on a row.
 *
 * Returns `null` when no SEO row exists (LEFT JOIN miss → `seo_no_index` is
 * NULL, since the column is `NOT NULL DEFAULT 0` whenever a row is present).
 * Returning null keeps the `seo` key off entries that have none, so
 * `getSeoMeta()` falls back to its defaults exactly as before.
 */
function extractSeo(row: Record<string, unknown>): EntrySeo | null {
	const noIndex = row[SEO_COLUMN_ALIASES.seo_no_index];
	if (noIndex === null || noIndex === undefined) return null;
	const title = row[SEO_COLUMN_ALIASES.seo_title];
	const description = row[SEO_COLUMN_ALIASES.seo_description];
	const image = row[SEO_COLUMN_ALIASES.seo_image];
	const canonical = row[SEO_COLUMN_ALIASES.seo_canonical];
	return {
		title: typeof title === "string" ? title : null,
		description: typeof description === "string" ? description : null,
		image: typeof image === "string" ? image : null,
		canonical: typeof canonical === "string" ? canonical : null,
		noIndex: noIndex === 1,
	};
}

/**
 * Get the table name for a collection type
 */
function getTableName(type: string): string {
	validateIdentifier(type, "collection type");
	return `ec_${type}`;
}

/**
 * Cache for taxonomy names (only used for the primary database).
 * Skipped when a per-request DB override is active (e.g. preview mode)
 * because the override DB may have different taxonomies.
 */
let taxonomyNames: Set<string> | null = null;

/**
 * Get all taxonomy names (cached for the primary DB, bypassed only when
 * the per-request DB is an isolated instance — playground / DO preview).
 * Plain D1 Sessions routing shares schema with the singleton, so the
 * module-scoped cache stays valid.
 */
async function getTaxonomyNames(db: Kysely<Database>): Promise<Set<string>> {
	const hasIsolatedDb = getRequestContext()?.dbIsIsolated === true;

	if (!hasIsolatedDb && taxonomyNames) {
		return taxonomyNames;
	}

	try {
		const defs = await db.selectFrom("_emdash_taxonomy_defs").select("name").execute();
		const names = new Set(defs.map((d) => d.name));
		if (!hasIsolatedDb) {
			taxonomyNames = names;
		}
		return names;
	} catch {
		// Table doesn't exist yet, return empty set
		const empty = new Set<string>();
		if (!hasIsolatedDb) {
			taxonomyNames = empty;
		}
		return empty;
	}
}

/**
 * Reset the module-scoped taxonomy-names cache.
 *
 * Called from `invalidateTaxonomyDefsCache()` so that creating or seeding a
 * taxonomy definition is reflected within the current isolate instead of
 * waiting for the isolate to recycle. Keeps this cache consistent with the
 * isolate-wide taxonomy-defs cache in `taxonomies/index.ts`.
 */
export function resetTaxonomyNamesCache(): void {
	taxonomyNames = null;
}

/**
 * System columns to include in data (mapped to camelCase where needed)
 */
const INCLUDE_IN_DATA: Record<string, string> = {
	id: "id",
	status: "status",
	author_id: "authorId",
	primary_byline_id: "primaryBylineId",
	created_at: "createdAt",
	updated_at: "updatedAt",
	published_at: "publishedAt",
	scheduled_at: "scheduledAt",
	draft_revision_id: "draftRevisionId",
	live_revision_id: "liveRevisionId",
	locale: "locale",
	translation_group: "translationGroup",
};

/** System date columns that should be converted to Date objects */
const DATE_COLUMNS = new Set(["created_at", "updated_at", "published_at", "scheduled_at"]);

/**
 * Hidden, symbol-keyed property on each mapped data record carrying the raw
 * DB string for every date column. Lets cursor encoders downstream reproduce
 * the loader's exact `nextCursor` format without round-tripping through
 * `new Date()`, which loses precision for stored values that aren't already
 * ISO-with-milliseconds (e.g. `2026-01-01T00:00:00Z` becomes
 * `2026-01-01T00:00:00.000Z`).
 */
export const CURSOR_RAW_VALUES: unique symbol = Symbol("emdash:cursorRawValues");

const LOCAL_MEDIA_FILE_PREFIX = "/_emdash/api/media/file/";
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

/** Safely extract a string value from a record, returning fallback if not a string */
function rowStr(row: Record<string, unknown>, key: string, fallback = ""): string {
	const val = row[key];
	return typeof val === "string" ? val : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBareMediaKey(src: string): boolean {
	return !src.startsWith("/") && !URL_SCHEME_PATTERN.test(src);
}

function normalizeLocalMediaValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(normalizeLocalMediaValue);
	}

	if (!isRecord(value)) {
		return value;
	}

	const normalized: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		normalized[key] = normalizeLocalMediaValue(child);
	}

	if (
		normalized.provider === "local" &&
		typeof normalized.src === "string" &&
		normalized.src.length > 0
	) {
		const src = normalized.src;
		if (src.startsWith(LOCAL_MEDIA_FILE_PREFIX)) {
			const id = src.slice(LOCAL_MEDIA_FILE_PREFIX.length);
			if (!normalized.id && id) {
				normalized.id = id;
			}
		} else if (isBareMediaKey(src)) {
			if (!normalized.id) {
				normalized.id = src;
			}
			normalized.src = `${LOCAL_MEDIA_FILE_PREFIX}${src}`;
		}
	}

	return normalized;
}

/**
 * Map a database row to entry data
 * Extracts content fields (non-system columns) and parses JSON where needed.
 * System columns needed for templates (id, status, dates) are included with camelCase names.
 */
function mapRowToData(row: Record<string, unknown>): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	const rawDateValues: Record<string, string> = {};

	for (const [key, value] of Object.entries(row)) {
		// Include certain system columns (mapped to camelCase where needed)
		if (key in INCLUDE_IN_DATA) {
			// Convert date columns from ISO strings to Date objects
			if (DATE_COLUMNS.has(key)) {
				if (typeof value === "string") {
					rawDateValues[key] = value;
					data[INCLUDE_IN_DATA[key]] = new Date(value);
				} else {
					data[INCLUDE_IN_DATA[key]] = null;
				}
			} else {
				data[INCLUDE_IN_DATA[key]] = value;
			}
			continue;
		}

		if (SYSTEM_COLUMNS.has(key)) continue;

		// Try to parse JSON strings (for portableText, json fields, etc.)
		if (typeof value === "string") {
			try {
				// Only parse if it looks like JSON (starts with { or [)
				if (value.startsWith("{") || value.startsWith("[")) {
					data[key] = normalizeLocalMediaValue(JSON.parse(value));
				} else {
					data[key] = value;
				}
			} catch {
				data[key] = value;
			}
		} else {
			data[key] = value;
		}
	}

	Object.defineProperty(data, CURSOR_RAW_VALUES, {
		value: rawDateValues,
		enumerable: false,
		configurable: false,
		writable: false,
	});

	return data;
}

/**
 * Map revision data (already-parsed JSON object) to entry data.
 * Strips _-prefixed metadata keys (e.g. _slug) used internally by revisions.
 */
function mapRevisionData(data: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		if (key.startsWith("_")) continue; // revision metadata
		result[key] = normalizeLocalMediaValue(value);
	}
	return result;
}

// Virtual module imports are lazy-loaded to avoid errors when importing
// emdash outside of Astro/Vite context (e.g., in astro.config.mjs)
let virtualConfig:
	| {
			database?: { config: unknown };
			i18n?: { defaultLocale: string; locales: string[]; prefixDefaultLocale?: boolean } | null;
	  }
	| undefined;
let virtualCreateDialect: ((config: unknown) => Dialect) | undefined;

async function loadVirtualModules() {
	if (virtualConfig === undefined) {
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore - virtual module
		const configModule = await import("virtual:emdash/config");
		virtualConfig = configModule.default;
	}
	if (virtualCreateDialect === undefined) {
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore - virtual module
		const dialectModule = await import("virtual:emdash/dialect");
		virtualCreateDialect = dialectModule.createDialect;
		// dialectType is no longer needed here — dialect detection is
		// done via the db adapter instance in dialect-helpers.ts
	}
}

/**
 * Entry data type - generic object
 */
export type EntryData = Record<string, unknown>;

/**
 * Sort direction
 */
export type SortDirection = "asc" | "desc";

/**
 * Order by specification - field name to direction
 * @example { created_at: "desc" } - Sort by created_at descending
 * @example { title: "asc" } - Sort by title ascending
 */
export type OrderBySpec = Record<string, SortDirection>;

/**
 * Build WHERE clause for status filtering.
 * When filtering for 'published' status, also include scheduled content
 * whose scheduled_at time has passed (treating it as effectively published).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
function buildStatusCondition(
	db: Kysely<any>,
	status: string,
	tablePrefix?: string,
): ReturnType<typeof sql> {
	const statusField = tablePrefix ? `${tablePrefix}.status` : "status";
	const scheduledAtField = tablePrefix ? `${tablePrefix}.scheduled_at` : "scheduled_at";

	if (status === "published") {
		// Include both published content AND scheduled content past its publish time.
		// scheduled_at is stored as text (ISO 8601). On Postgres, we must cast it
		// to timestamptz for the comparison with CURRENT_TIMESTAMP to work.
		const scheduledAtExpr = isPostgres(db)
			? sql`${sql.ref(scheduledAtField)}::timestamptz`
			: sql.ref(scheduledAtField);
		const nowExpr = isPostgres(db)
			? currentTimestampValue(db)
			: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
		return sql`(${sql.ref(statusField)} = 'published' OR (${sql.ref(statusField)} = 'scheduled' AND ${scheduledAtExpr} <= ${nowExpr}))`;
	}

	return sql`${sql.ref(statusField)} = ${status}`;
}

/**
 * Resolved primary sort field and direction (used for cursor pagination).
 */
interface PrimarySort {
	field: string;
	direction: SortDirection;
}

/**
 * Get the primary sort field from an orderBy spec (first valid field, or default).
 */
function getPrimarySort(orderBy: OrderBySpec | undefined, tablePrefix?: string): PrimarySort {
	if (orderBy) {
		for (const [field, direction] of Object.entries(orderBy)) {
			if (FIELD_NAME_PATTERN.test(field)) {
				const fullField = tablePrefix ? `${tablePrefix}.${field}` : field;
				return { field: fullField, direction };
			}
		}
	}
	const defaultField = tablePrefix ? `${tablePrefix}.created_at` : "created_at";
	return { field: defaultField, direction: "desc" };
}

/**
 * Build ORDER BY clause from orderBy spec
 * Validates field names to prevent SQL injection (alphanumeric + underscore only)
 * Supports multiple sort fields in object key order
 */
function buildOrderByClause(
	orderBy: OrderBySpec | undefined,
	tablePrefix?: string,
): ReturnType<typeof sql> {
	// Default to created_at DESC
	if (!orderBy || Object.keys(orderBy).length === 0) {
		const field = tablePrefix ? `${tablePrefix}.created_at` : "created_at";
		return sql`ORDER BY ${sql.ref(field)} DESC, ${sql.ref(tablePrefix ? `${tablePrefix}.id` : "id")} DESC`;
	}

	const sortParts: ReturnType<typeof sql>[] = [];

	for (const [field, direction] of Object.entries(orderBy)) {
		// Validate field name (alphanumeric + underscore only)
		if (!FIELD_NAME_PATTERN.test(field)) {
			continue; // Skip invalid field names
		}

		const fullField = tablePrefix ? `${tablePrefix}.${field}` : field;
		const dir = direction === "asc" ? sql`ASC` : sql`DESC`;
		sortParts.push(sql`${sql.ref(fullField)} ${dir}`);
	}

	// If no valid sort fields, fall back to default
	if (sortParts.length === 0) {
		const defaultField = tablePrefix ? `${tablePrefix}.created_at` : "created_at";
		return sql`ORDER BY ${sql.ref(defaultField)} DESC, ${sql.ref(tablePrefix ? `${tablePrefix}.id` : "id")} DESC`;
	}

	// Add id as tiebreaker to ensure stable cursor ordering
	const primary = getPrimarySort(orderBy, tablePrefix);
	const idField = tablePrefix ? `${tablePrefix}.id` : "id";
	const idDir = primary.direction === "asc" ? sql`ASC` : sql`DESC`;
	sortParts.push(sql`${sql.ref(idField)} ${idDir}`);

	return sql`ORDER BY ${sql.join(sortParts, sql`, `)}`;
}

/**
 * Build a cursor WHERE condition for keyset pagination.
 * Uses the primary sort field + id as tiebreaker for stable ordering.
 *
 * Throws `InvalidCursorError` if the cursor is malformed; callers should
 * let this propagate so users see a real error rather than silently
 * falling back to the first page.
 */
function buildCursorCondition(
	cursor: string,
	orderBy: OrderBySpec | undefined,
	tablePrefix?: string,
): ReturnType<typeof sql> {
	const { orderValue, id: cursorId } = decodeCursor(cursor);
	const primary = getPrimarySort(orderBy, tablePrefix);
	const idField = tablePrefix ? `${tablePrefix}.id` : "id";

	if (primary.direction === "desc") {
		return sql`(${sql.ref(primary.field)} < ${orderValue} OR (${sql.ref(primary.field)} = ${orderValue} AND ${sql.ref(idField)} < ${cursorId}))`;
	}
	return sql`(${sql.ref(primary.field)} > ${orderValue} OR (${sql.ref(primary.field)} = ${orderValue} AND ${sql.ref(idField)} > ${cursorId}))`;
}

/** Type guard: is the where value a range object (not a string or array)? */
function isWhereRange(value: WhereValue): value is WhereRange {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Build AND conditions for non-taxonomy field filters.
 * Returns an array of sql fragments; empty if no field filters apply.
 * Field names are validated against FIELD_NAME_PATTERN to prevent injection.
 */
function buildFieldConditions(
	fields: Record<string, WhereValue>,
	tablePrefix?: string,
): ReturnType<typeof sql>[] {
	const conditions: ReturnType<typeof sql>[] = [];

	for (const [key, value] of Object.entries(fields)) {
		if (!FIELD_NAME_PATTERN.test(key)) {
			console.warn(`[emdash] where filter: invalid field name "${key}" ignored`);
			continue;
		}
		if (value == null) continue;
		const ref = tablePrefix ? sql.ref(`${tablePrefix}.${key}`) : sql.ref(key);

		if (isWhereRange(value)) {
			if (value.gt !== undefined) conditions.push(sql`${ref} > ${value.gt}`);
			if (value.gte !== undefined) conditions.push(sql`${ref} >= ${value.gte}`);
			if (value.lt !== undefined) conditions.push(sql`${ref} < ${value.lt}`);
			if (value.lte !== undefined) conditions.push(sql`${ref} <= ${value.lte}`);
		} else if (Array.isArray(value)) {
			if (value.length > 0) {
				conditions.push(sql`${ref} IN (${sql.join(value.map((v) => sql`${v}`))})`);
			}
		} else {
			conditions.push(sql`${ref} = ${value}`);
		}
	}

	return conditions;
}

/**
 * Range filter for comparison operators on field values.
 * Values are compared as strings in the database. This works correctly for
 * ISO 8601 dates (e.g. "2024-01-01T00:00:00Z") because lexicographic ordering
 * matches chronological ordering. Ensure date values use a consistent format.
 */
export interface WhereRange {
	gt?: string;
	gte?: string;
	lt?: string;
	lte?: string;
}

/**
 * A where clause value: exact match, multi-value match, or range comparison.
 */
export type WhereValue = string | string[] | WhereRange;

/**
 * Filter for loadCollection - type is required
 */
export interface CollectionFilter {
	type: string;
	status?: "draft" | "published" | "archived";
	limit?: number;
	/**
	 * Opaque cursor for keyset pagination.
	 * Pass the `nextCursor` value from a previous result to fetch the next page.
	 */
	cursor?: string;
	/**
	 * Filter by field values, taxonomy terms, or ranges.
	 *
	 * Taxonomy names are detected automatically and filtered via JOIN.
	 * Other keys are treated as column filters on the content table.
	 *
	 * @example { category: 'news' } - taxonomy term
	 * @example { series: 'main' } - exact match on a content field
	 * @example { published_at: { gte: '2024-01-01', lt: '2025-01-01' } } - date range
	 */
	where?: Record<string, WhereValue>;
	/**
	 * Order results by field(s)
	 * @default { created_at: "desc" }
	 */
	orderBy?: OrderBySpec;
	/**
	 * Filter by locale (e.g. 'en', 'fr').
	 * When set, only returns content in this locale.
	 */
	locale?: string;
}

/**
 * Filter for loadEntry - type and id are required
 */
export interface EntryFilter {
	type: string;
	id: string;
	/**
	 * When set, fetch content data from this revision instead of the content table.
	 * Used by preview mode to serve draft revision data.
	 */
	revisionId?: string;
	/**
	 * Locale to scope slug lookup. Only affects slug resolution;
	 * IDs are globally unique and always resolve regardless of locale.
	 */
	locale?: string;
}

// Cached database instance (shared across calls)
let dbInstance: Kysely<Database> | null = null;

/**
 * Get the database instance. Used by query wrapper functions and middleware.
 *
 * Checks the ALS request context first — if a per-request DB override is set
 * (e.g. by DO preview middleware), it takes precedence over the module-level
 * cached instance. This allows preview mode to route queries to an isolated
 * Durable Object database without modifying any calling code.
 *
 * Initializes the default database on first call using config from virtual module.
 */
export async function getDb(): Promise<Kysely<Database>> {
	// Per-request DB override via ALS (normal mode)
	const ctx = getRequestContext();
	if (ctx?.db) {
		return ctx.db as Kysely<Database>; // eslint-disable-line typescript/no-unsafe-type-assertion -- db is typed as unknown in RequestContext to avoid circular deps
	}

	if (!dbInstance) {
		await loadVirtualModules();
		if (!virtualConfig?.database || typeof virtualCreateDialect !== "function") {
			throw new Error(
				"EmDash database not configured. Add database config to emdash() in astro.config.mjs",
			);
		}
		const dialect = virtualCreateDialect(virtualConfig.database.config);
		dbInstance = new Kysely<Database>({ dialect, log: kyselyLogOption() });
	}
	return dbInstance;
}

/**
 * Create an EmDash Live Collections loader
 *
 * This loader handles ALL content types in a single Astro collection.
 * Use `getEmDashCollection()` and `getEmDashEntry()` to query
 * specific content types.
 *
 * Database is configured in astro.config.mjs via the emdash() integration.
 *
 * @example
 * ```ts
 * // src/live.config.ts
 * import { defineLiveCollection } from "astro:content";
 * import { emdashLoader } from "emdash";
 *
 * export const collections = {
 *   emdash: defineLiveCollection({
 *     loader: emdashLoader(),
 *   }),
 * };
 * ```
 */
export function emdashLoader(): LiveLoader<EntryData, EntryFilter, CollectionFilter> {
	return {
		name: "emdash",

		/**
		 * Load all entries for a content type
		 */
		async loadCollection({ filter }) {
			try {
				// Get DB instance (initializes on first use)
				const db = await getDb();

				// Type filter is required
				const type = filter?.type;
				if (!type) {
					return {
						error: new Error(
							"type filter is required. Use getEmDashCollection() instead of getLiveCollection() directly.",
						),
					};
				}

				// Query the per-collection table (ec_posts, ec_products, etc.)
				const tableName = getTableName(type);

				// Build query with dynamic table name
				const status = filter?.status || "published";
				const limit = filter?.limit;
				const cursor = filter?.cursor;
				const where = filter?.where;
				const orderBy = filter?.orderBy;
				const locale = filter?.locale;

				// Cursor pagination: over-fetch by 1 to detect next page
				const fetchLimit = limit ? limit + 1 : undefined;

				// Build cursor condition if cursor is provided
				const cursorCondition = cursor ? buildCursorCondition(cursor, orderBy) : null;
				const cursorConditionPrefixed = cursor
					? buildCursorCondition(cursor, orderBy, tableName)
					: null;

				// Separate taxonomy filters from field filters
				let result: { rows: Record<string, unknown>[] };
				let taxonomyFilter: { name: string; slugs: string[] } | null = null;
				const fieldFilters: Record<string, WhereValue> = {};

				if (where && Object.keys(where).length > 0) {
					const taxNames = await getTaxonomyNames(db);

					for (const [key, value] of Object.entries(where)) {
						if (value == null) continue;
						if (taxNames.has(key)) {
							if (isWhereRange(value)) {
								console.warn(
									`[emdash] where filter: range operators are not supported on taxonomy "${key}", ignored`,
								);
								continue;
							}
							if (taxonomyFilter) {
								console.warn(
									`[emdash] where filter: only one taxonomy is supported per query, "${key}" ignored`,
								);
								continue;
							}
							const slugs = Array.isArray(value) ? value : [value];
							taxonomyFilter = { name: key, slugs };
						} else {
							fieldFilters[key] = value;
						}
					}
				}

				if (taxonomyFilter) {
					const orderByClause = buildOrderByClause(orderBy, tableName);
					const statusCondition = buildStatusCondition(db, status, tableName);
					const localeCondition = locale
						? sql`AND ${sql.ref(tableName)}.locale = ${locale}`
						: sql``;
					const cursorCond = cursorConditionPrefixed ? sql`AND ${cursorConditionPrefixed}` : sql``;
					const fieldConds = buildFieldConditions(fieldFilters, tableName);
					const fieldCondsSQL =
						fieldConds.length > 0 ? sql`${sql.join(fieldConds, sql` AND `)}` : null;

					result = await sql<Record<string, unknown>>`
						SELECT DISTINCT ${sql.ref(tableName)}.* FROM ${sql.ref(tableName)}
						INNER JOIN content_taxonomies ct
							ON ct.collection = ${type}
							AND ct.entry_id = ${sql.ref(tableName)}.id
						INNER JOIN taxonomies t
							ON t.id = ct.taxonomy_id
						WHERE ${sql.ref(tableName)}.deleted_at IS NULL
							AND ${statusCondition}
							${localeCondition}
							${cursorCond}
							AND t.name = ${taxonomyFilter.name}
							AND t.slug IN (${sql.join(taxonomyFilter.slugs.map((s) => sql`${s}`))})
							${fieldCondsSQL ? sql`AND ${fieldCondsSQL}` : sql``}
						${orderByClause}
						${fetchLimit ? sql`LIMIT ${fetchLimit}` : sql``}
					`.execute(db);
				} else {
					const orderByClause = buildOrderByClause(orderBy);
					const statusCondition = buildStatusCondition(db, status);
					const localeFilter = locale ? sql`AND locale = ${locale}` : sql``;
					const cursorCond = cursorCondition ? sql`AND ${cursorCondition}` : sql``;
					const fieldConds = buildFieldConditions(fieldFilters);
					const fieldCondsSQL =
						fieldConds.length > 0 ? sql`${sql.join(fieldConds, sql` AND `)}` : null;

					result = await sql<Record<string, unknown>>`
						SELECT * FROM ${sql.ref(tableName)}
						WHERE deleted_at IS NULL
						AND ${statusCondition}
						${localeFilter}
						${cursorCond}
						${fieldCondsSQL ? sql`AND ${fieldCondsSQL}` : sql``}
						${orderByClause}
						${fetchLimit ? sql`LIMIT ${fetchLimit}` : sql``}
					`.execute(db);
				}

				// Detect whether there are more results (over-fetched by 1)
				const hasMore = limit ? result.rows.length > limit : false;
				const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

				// Map rows to entries
				const i18nConfig = virtualConfig?.i18n;
				const i18nEnabled = i18nConfig && i18nConfig.locales.length > 1;
				const entries = rows.map((row) => {
					const slug = rowStr(row, "slug") || rowStr(row, "id");
					const rowLocale = rowStr(row, "locale");
					const shouldPrefix =
						i18nEnabled &&
						rowLocale !== "" &&
						(rowLocale !== i18nConfig.defaultLocale || i18nConfig.prefixDefaultLocale);
					const id = shouldPrefix ? `${rowLocale}/${slug}` : slug;
					return {
						id,
						slug: rowStr(row, "slug"),
						status: rowStr(row, "status", "draft"),
						data: mapRowToData(row),
						cacheHint: {
							tags: [rowStr(row, "id")],
							lastModified: row.updated_at ? new Date(rowStr(row, "updated_at")) : undefined,
						},
					};
				});

				// Encode nextCursor from the last row if there are more results
				let nextCursor: string | undefined;
				if (hasMore && rows.length > 0) {
					const lastRow = rows.at(-1)!;
					const primary = getPrimarySort(orderBy);
					// Strip table prefix from field name for row lookup
					const fieldName = primary.field.includes(".")
						? primary.field.split(".").pop()!
						: primary.field;
					const lastOrderValue = lastRow[fieldName];
					const orderStr =
						typeof lastOrderValue === "string" || typeof lastOrderValue === "number"
							? String(lastOrderValue)
							: "";
					nextCursor = encodeCursor(orderStr, String(lastRow.id));
				}

				// Collection-level cache hint uses the most recent updated_at
				let collectionLastModified: Date | undefined;
				for (const row of rows) {
					if (row.updated_at) {
						const d = new Date(rowStr(row, "updated_at"));
						if (!collectionLastModified || d > collectionLastModified) {
							collectionLastModified = d;
						}
					}
				}

				return {
					entries,
					nextCursor,
					cacheHint: {
						tags: [type],
						lastModified: collectionLastModified,
					},
				};
			} catch (error) {
				// Handle missing table/column gracefully - return empty collection.
				// Missing table happens before migrations have run.
				// Missing column happens when a where filter references a non-existent field.
				const message = error instanceof Error ? error.message : String(error);
				if (isMissingTableError(error) || isMissingColumnError(error)) {
					if (isMissingColumnError(error)) {
						console.warn(`[emdash] where filter: ${message}`);
					}
					return { entries: [] };
				}

				return {
					error: new Error(`Failed to load collection: ${message}`),
				};
			}
		},

		/**
		 * Load a single entry by type and ID/slug
		 *
		 * When filter.revisionId is set (preview mode), the entry's data
		 * comes from the revisions table instead of the content table columns.
		 */
		async loadEntry({ filter }) {
			try {
				// Get DB instance
				const db = await getDb();

				// Both type and id are required
				const type = filter?.type;
				const id = filter?.id;

				if (!type || !id) {
					return {
						error: new Error(
							"type and id filters are required. Use getEmDashEntry() instead of getLiveEntry() directly.",
						),
					};
				}

				// Query the per-collection table
				const tableName = getTableName(type);
				const locale = filter?.locale;

				// Use raw SQL for dynamic table name, match by slug or id
				// When locale is specified, prefer locale-scoped slug match,
				// but IDs are globally unique so always check id without locale scope.
				//
				// LEFT JOIN _emdash_seo folds per-entry SEO (canonical, noindex,
				// etc.) into this single query at zero extra round-trip cost. The
				// joined columns are surfaced as a nested data.seo object via
				// extractSeo() and excluded from the generic field mapping. SEO is
				// 1:1 with content (PK on collection+content_id), so the join never
				// multiplies rows.
				const seoSelect = sql.join(
					Object.entries(SEO_COLUMN_ALIASES).map(
						([col, alias]) => sql`${sql.ref(`s.${col}`)} AS ${sql.ref(alias)}`,
					),
				);
				const result = locale
					? await sql<Record<string, unknown>>`
							SELECT c.*, ${seoSelect}
							FROM ${sql.ref(tableName)} AS c
							LEFT JOIN ${sql.ref("_emdash_seo")} AS s
								ON s.collection = ${type} AND s.content_id = c.id
							WHERE c.deleted_at IS NULL
							AND ((c.slug = ${id} AND c.locale = ${locale}) OR c.id = ${id})
							LIMIT 1
						`.execute(db)
					: await sql<Record<string, unknown>>`
							SELECT c.*, ${seoSelect}
							FROM ${sql.ref(tableName)} AS c
							LEFT JOIN ${sql.ref("_emdash_seo")} AS s
								ON s.collection = ${type} AND s.content_id = c.id
							WHERE c.deleted_at IS NULL
							AND (c.slug = ${id} OR c.id = ${id})
							LIMIT 1
						`.execute(db);

				const row = result.rows[0];
				if (!row) {
					return undefined;
				}

				const i18nConfig = virtualConfig?.i18n;
				const i18nEnabled = i18nConfig && i18nConfig.locales.length > 1;
				const entrySlug = rowStr(row, "slug") || rowStr(row, "id");
				const entryLocale = rowStr(row, "locale");
				const shouldPrefixEntry =
					i18nEnabled &&
					entryLocale !== "" &&
					(entryLocale !== i18nConfig.defaultLocale || i18nConfig.prefixDefaultLocale);
				const entryId = shouldPrefixEntry ? `${entryLocale}/${entrySlug}` : entrySlug;

				// Preview mode: override content fields with revision data,
				// keeping system metadata from the content table row.
				const revisionId = filter?.revisionId;
				if (revisionId) {
					const revRow = await sql<{ data: string }>`
						SELECT data FROM revisions
						WHERE id = ${revisionId}
						LIMIT 1
					`.execute(db);

					const revData = revRow.rows[0];
					if (revData) {
						const parsed: Record<string, unknown> = JSON.parse(revData.data);
						// System metadata from content table + content fields from revision
						const systemData: Record<string, unknown> = {};
						for (const [key, mappedKey] of Object.entries(INCLUDE_IN_DATA)) {
							if (key in row) {
								if (DATE_COLUMNS.has(key)) {
									systemData[mappedKey] = typeof row[key] === "string" ? new Date(row[key]) : null;
								} else {
									systemData[mappedKey] = row[key];
								}
							}
						}
						// Use slug from revision metadata if present, else from content table
						const slug = typeof parsed._slug === "string" ? parsed._slug : rowStr(row, "slug");
						const revSlug = slug || rowStr(row, "id");
						const revLocale = rowStr(row, "locale");
						const shouldPrefixRev =
							i18nEnabled &&
							revLocale !== "" &&
							(revLocale !== i18nConfig.defaultLocale || i18nConfig.prefixDefaultLocale);
						const revId = shouldPrefixRev ? `${revLocale}/${revSlug}` : revSlug;
						// SEO is not revisioned — it comes from the content row's
						// joined _emdash_seo columns, not the revision snapshot.
						const revEntryData: Record<string, unknown> = {
							...systemData,
							slug,
							...mapRevisionData(parsed),
						};
						const revSeo = extractSeo(row);
						if (revSeo) revEntryData.seo = revSeo;
						return {
							id: revId,
							slug,
							status: rowStr(row, "status", "draft"),
							data: revEntryData,
							cacheHint: {
								tags: [rowStr(row, "id")],
								lastModified: row.updated_at ? new Date(rowStr(row, "updated_at")) : undefined,
							},
						};
					}
				}

				const entryData = mapRowToData(row);
				const entrySeo = extractSeo(row);
				if (entrySeo) entryData.seo = entrySeo;
				return {
					id: entryId,
					slug: rowStr(row, "slug"),
					status: rowStr(row, "status", "draft"),
					data: entryData,
					cacheHint: {
						tags: [rowStr(row, "id")],
						lastModified: row.updated_at ? new Date(rowStr(row, "updated_at")) : undefined,
					},
				};
			} catch (error) {
				// Handle missing table gracefully - return undefined (not found).
				// This happens before migrations have run.
				if (isMissingTableError(error)) {
					return undefined;
				}

				const message = error instanceof Error ? error.message : String(error);
				return {
					error: new Error(`Failed to load entry: ${message}`),
				};
			}
		},
	};
}
