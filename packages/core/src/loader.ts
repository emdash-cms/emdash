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
import { Kysely, type RawBuilder, sql, type Dialect } from "kysely";

import { buildStatusCondition, isPostgres } from "./database/dialect-helpers.js";
import { kyselyLogOption } from "./database/instrumentation.js";
import { decodeCursor, encodeCursor } from "./database/repositories/types.js";
import { validateIdentifier } from "./database/validate.js";
import type { Database } from "./index.js";
import { getRequestContext } from "./request-context.js";
import { isMissingColumnError, isMissingTableError } from "./utils/db-errors.js";

const FIELD_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * SEO columns folded into the single-entry query as a single JSON column
 * (`_emdash_seo` in the result set), then expanded onto the row under these
 * aliases for `extractSeo()`. Surfacing SEO as one aggregated column keeps the
 * result-set width bounded regardless of how many fields the collection has,
 * which matters for D1: a flat `LEFT JOIN _emdash_seo` adds 5 alias columns to
 * every row and pushes wide collections (common after WordPress / ACF imports)
 * past D1's per-result-set column limit, surfacing as a silent null entry.
 * One JSON column is one column, so the join stays safe at any schema width.
 *
 * The aliases mirror the strategy used by `foldedHydrationSelects` for byline
 * and taxonomy hydration: aggregate in SQL, expand in JS. SEO is 1:1 with
 * content, so the subquery uses `json_object` (not the array aggregator).
 *
 * The `_emdash_` prefix on the aliases guarantees they can never collide with
 * a content field. Field slugs must match `/^[a-z][a-z0-9_]*$/`, so a user can
 * legitimately define a `seo_title` field; surfacing the SEO column under its
 * bare name would shadow that field in the result set and drop the user's
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

/** Folded SEO JSON column name in the result set (expanded onto aliases in JS). */
const SEO_FOLDED_COLUMN = "_emdash_seo";

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
	// Aliased SEO columns expanded from the folded _emdash_seo JSON column on
	// the single-entry path. Surfaced as a nested data.seo object (see
	// extractSeo), never as flat fields. The aliases are _emdash_-prefixed so
	// they can't shadow a user field named e.g. `seo_title`.
	...SEO_ALIAS_COLUMNS,
	// Folded hydration JSON columns (see foldedHydrationSelects and
	// foldedSeoSelect) — surfaced via the FOLDED_* markers or expanded onto
	// SEO_ALIAS_COLUMNS, never as flat fields.
	"_emdash_terms",
	"_emdash_bylines",
	SEO_FOLDED_COLUMN,
]);

/** Markers for byline/taxonomy hydration folded into the content query. */
export const FOLDED_TERMS = Symbol.for("emdash:foldedTerms");
export const FOLDED_BYLINES = Symbol.for("emdash:foldedBylines");

/**
 * Correlated JSON-array subqueries that fold taxonomy-term and byline hydration
 * into the content query, removing the two separate hydration round trips per
 * fetch. `outer` is the content table's alias/name; each subquery correlates on
 * `<outer>.id`, so the base query stays one row per entry (no join fan-out, no
 * duplicated content payload). Order is NOT applied in the aggregate (it differs
 * across dialects) — the consumer sorts terms by label and credits by sortOrder.
 *
 * Dialect-specific aggregation: SQLite `json_group_array`/`json_object` returns
 * a JSON *string*; Postgres `json_agg`/`json_build_object` (coalesced to `[]`)
 * returns parsed JSON. {@link stashFolded} handles both.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any Kysely instance
function foldedHydrationSelects(db: Kysely<any>, type: string, outer: string) {
	const o = sql.ref(outer);
	const pg = isPostgres(db);
	const obj = (pairs: string) =>
		pg ? sql.raw(`json_build_object(${pairs})`) : sql.raw(`json_object(${pairs})`);
	const agg = (inner: RawBuilder<unknown>) =>
		pg ? sql`coalesce(json_agg(${inner}), '[]'::json)` : sql`json_group_array(${inner})`;

	// Pin the join order for the per-entry hydration subqueries on SQLite (#1722).
	// SQLite honours `CROSS JOIN` ordering, forcing the join to drive from the
	// pivot (`content_taxonomies` / `_emdash_content_bylines`) by
	// `(collection, entry_id)` and probe the term/byline table by
	// `translation_group`. Without it, a stats-blind D1 planner (D1 never runs
	// ANALYZE / maintains `sqlite_stat1`) is free to drive the correlated
	// subquery from `taxonomies`/`_emdash_bylines` by `locale`, scanning every
	// row in the locale per emitted entry. Postgres keeps statistics and rejects
	// `CROSS JOIN … ON`, so it stays a plain `JOIN` there.
	const foldJoin = pg ? sql`JOIN` : sql`CROSS JOIN`;

	const termObj = obj(
		"'id', t.id, 'name', t.name, 'slug', t.slug, 'label', t.label, 'parent_id', t.parent_id, 'locale', t.locale, 'translation_group', t.translation_group",
	);
	// Filter terms to the entry's own locale (matches #1441: terms render in the
	// entry's resolved locale, not all locale variants of the attached group).
	const terms = sql`(SELECT ${agg(termObj)} FROM ${sql.ref("content_taxonomies")} AS ct ${foldJoin} ${sql.ref("taxonomies")} AS t ON t.translation_group = ct.taxonomy_id WHERE ct.collection = ${type} AND ct.entry_id = ${o}.id AND t.locale = ${o}.locale) AS ${sql.ref("_emdash_terms")}`;

	const bylineInner = obj(
		"'id', b.id, 'slug', b.slug, 'displayName', b.display_name, 'bio', b.bio, 'avatarMediaId', b.avatar_media_id, 'avatarStorageKey', m.storage_key, 'avatarAlt', m.alt, 'avatarBlurhash', m.blurhash, 'avatarDominantColor', m.dominant_color, 'websiteUrl', b.website_url, 'userId', b.user_id, 'isGuest', b.is_guest, 'createdAt', b.created_at, 'updatedAt', b.updated_at, 'locale', b.locale, 'translationGroup', b.translation_group",
	);
	const creditObj = pg
		? sql.raw(
				"json_build_object('roleLabel', cb.role_label, 'sortOrder', cb.sort_order, 'byline', ",
			)
		: sql.raw("json_object('roleLabel', cb.role_label, 'sortOrder', cb.sort_order, 'byline', ");
	const credit = sql`${creditObj}${bylineInner})`;
	const bylines = sql`(SELECT ${agg(credit)} FROM ${sql.ref("_emdash_content_bylines")} AS cb ${foldJoin} ${sql.ref("_emdash_bylines")} AS b ON b.translation_group = cb.byline_id LEFT JOIN ${sql.ref("media")} AS m ON m.id = b.avatar_media_id WHERE cb.collection_slug = ${type} AND cb.content_id = ${o}.id AND b.locale = ${o}.locale) AS ${sql.ref("_emdash_bylines")}`;
	return { terms, bylines };
}

/**
 * Correlated JSON-object subquery that folds per-entry SEO into the content
 * query without widening the result set: 1 row of `_emdash_seo` becomes 1 JSON
 * column rather than 5 flat columns. The JSON column is expanded onto the row
 * via {@link expandFoldedSeo} after the query runs, preserving the alias keys
 * that {@link extractSeo} reads. Missing SEO row (no entry in `_emdash_seo`)
 * yields NULL, which {@link expandFoldedSeo} treats as "no SEO" - identical to
 * the prior LEFT JOIN miss behavior.
 *
 * Dialect-specific aggregation mirrors {@link foldedHydrationSelects}: SQLite
 * `json_object` returns a JSON *string*, Postgres `json_build_object` returns
 * parsed JSON; both branches are handled in expansion.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any Kysely instance
function foldedSeoSelect(db: Kysely<any>, type: string, outer: string) {
	const o = sql.ref(outer);
	const pg = isPostgres(db);
	// Use raw column names (not aliases) as JSON keys: the JSON is expanded back
	// onto SEO_COLUMN_ALIASES in JS, and keeping the keys matched to the
	// underlying columns makes the SQL readable and the expansion 1-to-1.
	const pairs =
		"'seo_title', s.seo_title, 'seo_description', s.seo_description, 'seo_image', s.seo_image, 'seo_canonical', s.seo_canonical, 'seo_no_index', s.seo_no_index";
	const obj = pg ? sql.raw(`json_build_object(${pairs})`) : sql.raw(`json_object(${pairs})`);
	return sql`(SELECT ${obj} FROM ${sql.ref("_emdash_seo")} AS s WHERE s.collection = ${type} AND s.content_id = ${o}.id LIMIT 1) AS ${sql.ref(SEO_FOLDED_COLUMN)}`;
}

/**
 * Expand the folded `_emdash_seo` JSON column onto the row using SEO_COLUMN_ALIASES,
 * so {@link extractSeo} reads it transparently. SQLite returns a JSON string
 * (parse it); Postgres returns already-parsed JSON. Missing/malformed/null is
 * a no-op: {@link extractSeo} returns null when the aliases are absent.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function expandFoldedSeo(row: Record<string, unknown>): void {
	const raw = row[SEO_FOLDED_COLUMN];
	delete row[SEO_FOLDED_COLUMN];
	let parsed: Record<string, unknown> | null = null;
	if (typeof raw === "string") {
		try {
			const candidate: unknown = JSON.parse(raw);
			if (isPlainObject(candidate)) parsed = candidate;
		} catch {
			return; // malformed JSON: leave the row without SEO aliases (extractSeo returns null)
		}
	} else if (isPlainObject(raw)) {
		parsed = raw;
	}
	if (!parsed) return;
	for (const [col, alias] of Object.entries(SEO_COLUMN_ALIASES)) {
		row[alias] = parsed[col] ?? null;
	}
}

/**
 * Stash folded hydration JSON (non-enumerable) for the query.ts fast paths.
 * SQLite returns a JSON string (parse it); Postgres returns already-parsed JSON.
 */
function stashFolded(data: Record<string, unknown>, row: Record<string, unknown>): void {
	for (const [col, sym] of [
		["_emdash_terms", FOLDED_TERMS],
		["_emdash_bylines", FOLDED_BYLINES],
	] as const) {
		const raw = row[col];
		let value: unknown;
		if (typeof raw === "string") {
			try {
				value = JSON.parse(raw);
			} catch {
				continue; // malformed: fall back to the query path
			}
		} else if (Array.isArray(raw)) {
			value = raw; // Postgres json/jsonb already parsed by the driver
		} else {
			continue;
		}
		Object.defineProperty(data, sym, { value, enumerable: false, configurable: true });
	}
}

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
 * Fields shared by every collection filter, independent of pagination mode.
 *
 * Cursor and offset pagination are mutually exclusive, so they live on the
 * `CursorCollectionFilter` / `OffsetCollectionFilter` variants rather than
 * here. Use the {@link CollectionFilter} union for any value that may be
 * either.
 */
export interface CollectionFilterBase {
	type: string;
	status?: "draft" | "published" | "archived";
	limit?: number;
	/**
	 * Filter by field values, taxonomy terms, byline credits, or ranges.
	 *
	 * Taxonomy names are detected automatically and filtered via JOIN.
	 * The reserved `byline` key filters by byline credit (any credit, not
	 * just the primary one) via the `_emdash_content_bylines` junction
	 * table; its value is one or more byline translation groups.
	 * Other keys are treated as column filters on the content table.
	 *
	 * @example { category: 'news' } - taxonomy term
	 * @example { byline: '01HXYZ...' } - entries credited to a byline (any position)
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

/** Keyset-paginated collection filter. Cannot also carry an `offset`. */
export interface CursorCollectionFilter extends CollectionFilterBase {
	/**
	 * Opaque cursor for keyset pagination.
	 * Pass the `nextCursor` value from a previous result to fetch the next page.
	 */
	cursor?: string;
	offset?: never;
}

/** Offset-paginated collection filter. Cannot also carry a `cursor`. */
export interface OffsetCollectionFilter extends CollectionFilterBase {
	/**
	 * Skip this many rows before returning results (offset pagination).
	 * Use with `limit` for numbered archive routes (`/page/2`):
	 * `offset = (page - 1) * perPage`. Ignored unless it is a positive
	 * integer.
	 */
	offset?: number;
	cursor?: never;
}

/**
 * Filter for loadCollection - type is required.
 *
 * A union of the cursor and offset pagination variants: supplying both
 * `cursor` and `offset` is a compile-time error, since they are mutually
 * exclusive ways to express "the next page" (cursor wins at runtime).
 */
export type CollectionFilter = CursorCollectionFilter | OffsetCollectionFilter;

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

				// Offset pagination (numbered archive routes). Keyset (cursor)
				// and offset are mutually exclusive ways to express "the next
				// page" — when both are supplied, cursor wins and offset is
				// dropped so the two don't stack into a double skip. Only a
				// positive integer applies; 0 / negative / fractional are no-ops.
				const rawOffset = cursor ? undefined : filter?.offset;
				const offset =
					typeof rawOffset === "number" && Number.isInteger(rawOffset) && rawOffset > 0
						? rawOffset
						: undefined;

				// Build cursor condition if cursor is provided
				const cursorCondition = cursor ? buildCursorCondition(cursor, orderBy) : null;

				// Separate taxonomy / byline filters from field filters
				let result: { rows: Record<string, unknown>[] };
				// Taxonomy filters AND together: each entry constrains the base
				// row to match at least one of its slugs *within that taxonomy*.
				// Term slugs are unique only within a taxonomy, so every filter
				// keeps its own `name` and emits its own `EXISTS` clause rather
				// than pooling slugs into one `IN`.
				const taxonomyFilters: { name: string; slugs: string[] }[] = [];
				// A byline filter matches entries credited to any of the given
				// byline translation groups via the `_emdash_content_bylines`
				// junction table. `null` means no byline filter; an empty
				// `groups` array means the filter was requested but matches
				// nothing (short-circuited to an empty result below).
				let bylineFilter: { groups: string[] } | null = null;
				const fieldFilters: Record<string, WhereValue> = {};

				if (where && Object.keys(where).length > 0) {
					const taxNames = await getTaxonomyNames(db);

					for (const [key, value] of Object.entries(where)) {
						if (value == null) continue;
						if (key === "byline") {
							if (isWhereRange(value)) {
								console.warn(
									`[emdash] where filter: range operators are not supported on "byline", ignored`,
								);
								continue;
							}
							const groups = Array.isArray(value) ? value : [value];
							bylineFilter = { groups };
						} else if (taxNames.has(key)) {
							if (isWhereRange(value)) {
								console.warn(
									`[emdash] where filter: range operators are not supported on taxonomy "${key}", ignored`,
								);
								continue;
							}
							const slugs = Array.isArray(value) ? value : [value];
							taxonomyFilters.push({ name: key, slugs });
						} else {
							fieldFilters[key] = value;
						}
					}
				}

				// A byline or taxonomy filter with no values matches nothing —
				// short-circuit before building SQL (an empty `IN ()` is invalid
				// SQL on both dialects).
				if (
					(bylineFilter && bylineFilter.groups.length === 0) ||
					taxonomyFilters.some((f) => f.slugs.length === 0)
				) {
					return { entries: [], cacheHint: { tags: [type] } };
				}

				{
					// Taxonomy and byline filters are applied as correlated
					// `EXISTS` semi-joins rather than `INNER JOIN ... DISTINCT`.
					// A join fan-out would force `SELECT DISTINCT table.*`, and
					// Postgres cannot apply DISTINCT to a row containing a `json`
					// column (no equality operator), so the join approach throws
					// there. EXISTS matches "credited/tagged at least once"
					// without duplicating rows, needs no DISTINCT, and works on
					// both SQLite and Postgres. The base query stays a single-
					// table `SELECT *`, so all field/status/locale/cursor/order
					// conditions reference unprefixed columns as before.
					const orderByClause = buildOrderByClause(orderBy);
					const statusCondition = buildStatusCondition(db, status);
					const localeFilter = locale ? sql`AND locale = ${locale}` : sql``;
					const cursorCond = cursorCondition ? sql`AND ${cursorCondition}` : sql``;
					const fieldConds = buildFieldConditions(fieldFilters);
					const fieldCondsSQL =
						fieldConds.length > 0 ? sql`${sql.join(fieldConds, sql` AND `)}` : null;

					// One `EXISTS` per taxonomy, AND'd together: an entry must be
					// tagged with a matching term in *every* requested taxonomy.
					// Each clause pins its own `t.name`, so slugs never pool
					// across taxonomies (they're only unique within one).
					const taxonomyCond =
						taxonomyFilters.length > 0
							? sql`${sql.join(
									taxonomyFilters.map(
										(f) => sql`AND EXISTS (
							SELECT 1 FROM content_taxonomies ct
							INNER JOIN taxonomies t ON t.translation_group = ct.taxonomy_id
							WHERE ct.collection = ${type}
								AND ct.entry_id = ${sql.ref(tableName)}.id
								AND t.name = ${f.name}
								AND t.slug IN (${sql.join(f.slugs.map((s) => sql`${s}`))})
							${locale ? sql`AND t.locale = ${locale}` : sql``}
						)`,
									),
									sql` `,
								)}`
							: sql``;

					// `_emdash_content_bylines.byline_id` stores the byline's
					// translation_group (migration 040), so a credit spans every
					// locale variant of the byline and we match the group directly.
					const bylineCond = bylineFilter
						? sql`AND EXISTS (
							SELECT 1 FROM _emdash_content_bylines cb
							WHERE cb.collection_slug = ${type}
								AND cb.content_id = ${sql.ref(tableName)}.id
								AND cb.byline_id IN (${sql.join(bylineFilter.groups.map((g) => sql`${g}`))})
						)`
						: sql``;

					// Fold byline + taxonomy hydration into the list query.
					const { terms: termsSelect, bylines: bylinesSelect } = foldedHydrationSelects(
						db,
						type,
						tableName,
					);

					// LIMIT/OFFSET clause. SQLite only accepts OFFSET when a
					// LIMIT is present, so a bare offset uses `LIMIT -1`
					// (unbounded); Postgres takes a standalone OFFSET.
					let limitOffsetClause = sql``;
					if (fetchLimit != null && offset != null) {
						limitOffsetClause = sql`LIMIT ${fetchLimit} OFFSET ${offset}`;
					} else if (fetchLimit != null) {
						limitOffsetClause = sql`LIMIT ${fetchLimit}`;
					} else if (offset != null) {
						limitOffsetClause = isPostgres(db)
							? sql`OFFSET ${offset}`
							: sql`LIMIT -1 OFFSET ${offset}`;
					}
					result = await sql<Record<string, unknown>>`
						SELECT *, ${termsSelect}, ${bylinesSelect} FROM ${sql.ref(tableName)}
						WHERE deleted_at IS NULL
						AND ${statusCondition}
						${localeFilter}
						${cursorCond}
						${taxonomyCond}
						${bylineCond}
						${fieldCondsSQL ? sql`AND ${fieldCondsSQL}` : sql``}
						${orderByClause}
						${limitOffsetClause}
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
					const data = mapRowToData(row);
					stashFolded(data, row);
					return {
						id,
						slug: rowStr(row, "slug"),
						status: rowStr(row, "status", "draft"),
						data,
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
				// Byline + taxonomy hydration (foldedHydrationSelects) and per-entry
				// SEO (foldedSeoSelect) are each surfaced as a single aggregated JSON
				// column rather than flat columns. This keeps the result-set width
				// bounded at any collection schema width: a flat `LEFT JOIN _emdash_seo`
				// adds 5 alias columns to every row and pushes wide flat-schema
				// collections (common after WordPress / ACF imports) past D1's
				// per-result-set column limit, surfacing as a silent null entry. One
				// JSON column is one column, so the join stays safe at any width and
				// we keep the single round trip.
				const { terms: termsSelect, bylines: bylinesSelect } = foldedHydrationSelects(
					db,
					type,
					"c",
				);
				const seoSelect = foldedSeoSelect(db, type, "c");
				const result = locale
					? await sql<Record<string, unknown>>`
							SELECT c.*, ${seoSelect}, ${termsSelect}, ${bylinesSelect}
							FROM ${sql.ref(tableName)} AS c
							WHERE c.deleted_at IS NULL
							AND ((c.slug = ${id} AND c.locale = ${locale}) OR c.id = ${id})
							LIMIT 1
						`.execute(db)
					: await sql<Record<string, unknown>>`
							SELECT c.*, ${seoSelect}, ${termsSelect}, ${bylinesSelect}
							FROM ${sql.ref(tableName)} AS c
							WHERE c.deleted_at IS NULL
							AND (c.slug = ${id} OR c.id = ${id})
							LIMIT 1
						`.execute(db);

				const row = result.rows[0];
				if (!row) {
					return undefined;
				}

				// Expand the folded SEO JSON column onto SEO_COLUMN_ALIASES so
				// extractSeo() reads it transparently. Missing/null SEO is a
				// no-op: extractSeo() returns null when the aliases are absent.
				expandFoldedSeo(row);

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
				stashFolded(entryData, row);
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
