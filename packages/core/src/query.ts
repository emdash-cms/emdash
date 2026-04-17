/**
 * Query functions for EmDash content
 *
 * These wrap Astro's getLiveCollection/getLiveEntry with type filtering.
 * Use these instead of calling Astro's functions directly.
 *
 * Error handling follows Astro's pattern - returns { entries/entry, error }
 * so callers can gracefully handle errors (including 404s).
 *
 * Preview mode is handled implicitly via ALS request context —
 * no parameters needed. The middleware verifies the preview token
 * and sets the context; query functions read it automatically.
 */

import { getFallbackChain, getI18nConfig, isI18nEnabled } from "./i18n/config.js";
import { getRequestContext } from "./request-context.js";
import {
	createEditable,
	createNoop,
	type EditProxy,
	type EditableOptions,
} from "./visual-editing/editable.js";

/**
 * Collection type registry for type-safe queries.
 *
 * This interface is extended by the generated emdash-env.d.ts file
 * to provide type inference for collection names and their data shapes.
 *
 * @example
 * ```ts
 * // In emdash-env.d.ts (generated):
 * declare module "emdash" {
 *   interface EmDashCollections {
 *     posts: { title: string; content: PortableTextBlock[]; };
 *     pages: { title: string; body: PortableTextBlock[]; };
 *   }
 * }
 *
 * // Then in your code:
 * const { entries } = await getEmDashCollection("posts");
 * // entries[0].data.title is typed as string
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface EmDashCollections {}

/**
 * Helper type to infer the data type for a collection.
 * Returns the registered type if known, otherwise falls back to Record<string, unknown>.
 */
export type InferCollectionData<T extends string> = T extends keyof EmDashCollections
	? EmDashCollections[T]
	: Record<string, unknown>;

/**
 * Sort direction
 */
export type SortDirection = "asc" | "desc";

/**
 * Order by specification - field name to direction
 * @example { created_at: "desc" } - Sort by created_at descending
 * @example { title: "asc" } - Sort by title ascending
 * @example { published_at: "desc", title: "asc" } - Multi-field sort
 */
export type OrderBySpec = Record<string, SortDirection>;

export interface CollectionFilter {
	status?: "draft" | "published" | "archived";
	limit?: number;
	/**
	 * Opaque cursor for keyset pagination.
	 * Pass the `nextCursor` value from a previous result to fetch the next page.
	 * @example
	 * ```ts
	 * const cursor = Astro.url.searchParams.get("cursor") ?? undefined;
	 * const { entries, nextCursor } = await getEmDashCollection("posts", {
	 *   limit: 10,
	 *   cursor,
	 * });
	 * ```
	 */
	cursor?: string;
	/**
	 * Filter by field values or taxonomy terms
	 * @example { category: 'news' } - Filter by taxonomy term
	 * @example { category: ['news', 'featured'] } - Filter by multiple terms (OR)
	 */
	where?: Record<string, string | string[]>;
	/**
	 * Order results by field(s)
	 * @default { created_at: "desc" }
	 * @example { created_at: "desc" } - Sort by created_at descending (default)
	 * @example { title: "asc" } - Sort by title ascending
	 * @example { published_at: "desc", title: "asc" } - Multi-field sort
	 */
	orderBy?: OrderBySpec;
	/**
	 * Filter by locale. When set, only returns entries in this locale.
	 * Only relevant when i18n is configured.
	 * @example "en" — English entries only
	 * @example "fr" — French entries only
	 */
	locale?: string;
}

export interface ContentEntry<T = Record<string, unknown>> {
	id: string;
	data: T;
	/** Visual editing annotations. Spread onto elements: {...entry.edit.title} */
	edit: EditProxy;
}

/** Cache hint returned by the content loader for route caching */
export interface CacheHint {
	tags?: string[];
	lastModified?: Date;
}

/**
 * Result from getEmDashCollection
 */
export interface CollectionResult<T> {
	/** The entries (empty array if error or none found) */
	entries: ContentEntry<T>[];
	/** Error if the query failed */
	error?: Error;
	/** Cache hint for route caching (pass to Astro.cache.set()) */
	cacheHint: CacheHint;
	/**
	 * Opaque cursor for the next page.
	 * Undefined when there are no more results.
	 * Pass this as `cursor` in the next query to get the next page.
	 */
	nextCursor?: string;
}

/**
 * Result from getEmDashEntry
 */
export interface EntryResult<T> {
	/** The entry, or null if not found */
	entry: ContentEntry<T> | null;
	/** Error if the query failed (not set for "not found", only for actual errors) */
	error?: Error;
	/** Whether we're in preview mode (valid token was provided) */
	isPreview: boolean;
	/** Set when a fallback locale was used instead of the requested locale */
	fallbackLocale?: string;
	/** Cache hint for route caching (pass to Astro.cache.set()) */
	cacheHint: CacheHint;
}

const COLLECTION_NAME = "_emdash";

/** Symbol key for edit metadata on PT arrays — avoids collision with user data */
const EMDASH_EDIT = Symbol.for("__emdash");

/** Edit metadata attached to PT arrays in edit mode */
export interface EditFieldMeta {
	collection: string;
	id: string;
	field: string;
}

/** Type guard for EditFieldMeta */
function isEditFieldMeta(value: unknown): value is EditFieldMeta {
	if (typeof value !== "object" || value === null) return false;
	if (!("collection" in value) || !("id" in value) || !("field" in value)) return false;
	// After `in` checks, TS narrows to Record<"collection" | "id" | "field", unknown>
	const { collection, id, field } = value;
	return typeof collection === "string" && typeof id === "string" && typeof field === "string";
}

/**
 * Read edit metadata from a value (returns undefined if not tagged).
 * Uses Object.getOwnPropertyDescriptor to access Symbol-keyed property
 * without an unsafe type assertion.
 */
export function getEditMeta(value: unknown): EditFieldMeta | undefined {
	if (value && typeof value === "object") {
		const desc = Object.getOwnPropertyDescriptor(value, EMDASH_EDIT);
		const meta: unknown = desc?.value;
		if (isEditFieldMeta(meta)) {
			return meta;
		}
	}
	return undefined;
}

/**
 * Tag PT-like arrays in entry data with edit metadata (non-enumerable).
 * A PT array is identified by: is an array, first element has _type property.
 */
function tagEditableFields(data: Record<string, unknown>, collection: string, id: string): void {
	for (const [field, value] of Object.entries(data)) {
		if (
			Array.isArray(value) &&
			value.length > 0 &&
			value[0] &&
			typeof value[0] === "object" &&
			"_type" in value[0]
		) {
			Object.defineProperty(value, EMDASH_EDIT, {
				value: { collection, id, field } satisfies EditFieldMeta,
				enumerable: false,
				configurable: true,
			});
		}
	}
}

/** Safely read a string field from a Record, with optional fallback */
function dataStr(data: Record<string, unknown>, key: string, fallback = ""): string {
	const val = data[key];
	return typeof val === "string" ? val : fallback;
}

/** Type guard for Record<string, unknown> */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract data as Record from an Astro entry (which is any-typed) */
function entryData(entry: { data?: unknown }): Record<string, unknown> {
	return isRecord(entry.data) ? entry.data : {};
}

/** Extract the database ID from entry data (data.id is the ULID, entry.id is the slug) */
function entryDatabaseId(entry: { id: string; data?: unknown }): string {
	const d = entryData(entry);
	return dataStr(d, "id") || entry.id;
}

/** Extract edit options from entry data for the proxy */
function entryEditOptions(entry: { data?: unknown }): EditableOptions {
	const data = entryData(entry);
	const status = dataStr(data, "status", "draft");
	const draftRevisionId = dataStr(data, "draftRevisionId") || undefined;
	const liveRevisionId = dataStr(data, "liveRevisionId") || undefined;
	const hasDraft = !!draftRevisionId && draftRevisionId !== liveRevisionId;
	return { status, hasDraft };
}

/**
 * Get all entries of a content type
 *
 * Returns { entries, error } for graceful error handling.
 *
 * When emdash-env.d.ts is generated, the collection name will be
 * type-checked and the return type will be inferred automatically.
 *
 * @example
 * ```ts
 * import { getEmDashCollection } from "emdash";
 *
 * const { entries: posts, error } = await getEmDashCollection("posts");
 * if (error) {
 *   console.error("Failed to load posts:", error);
 *   return;
 * }
 * // posts[0].data.title is typed (if emdash-env.d.ts exists)
 *
 * // With filters
 * const { entries: drafts } = await getEmDashCollection("posts", { status: "draft" });
 * ```
 */
export async function getEmDashCollection<T extends string, D = InferCollectionData<T>>(
	type: T,
	filter?: CollectionFilter,
): Promise<CollectionResult<D>> {
	// Dynamic import to avoid build-time issues
	const { getLiveCollection } = await import("astro:content");

	// Resolve locale: explicit filter > ALS context > defaultLocale (when i18n enabled)
	// Without this, queries return all locale rows, producing broken IDs
	const ctx = getRequestContext();
	const i18nConfig = getI18nConfig();
	const resolvedLocale =
		filter?.locale ?? ctx?.locale ?? (isI18nEnabled() ? i18nConfig!.defaultLocale : undefined);

	const result = await getLiveCollection(COLLECTION_NAME, {
		type,
		status: filter?.status,
		limit: filter?.limit,
		cursor: filter?.cursor,
		where: filter?.where,
		orderBy: filter?.orderBy,
		locale: resolvedLocale,
	});

	const { entries, error, cacheHint } = result;
	// nextCursor is returned by the emdash loader but not part of Astro's base
	// LiveLoader return type. Extract it safely via property descriptor to avoid
	// an unsafe type assertion on the `any`-typed result object.
	const rawCursor = Object.getOwnPropertyDescriptor(result, "nextCursor")?.value;
	const nextCursor: string | undefined = typeof rawCursor === "string" ? rawCursor : undefined;

	if (error) {
		return { entries: [], error, cacheHint: {} };
	}

	const isEditMode = ctx?.editMode ?? false;
	const entriesWithEdit = entries.map((entry: ContentEntry<D>) => {
		const dbId = entryDatabaseId(entry);
		if (isEditMode) {
			tagEditableFields(entryData(entry), type, dbId);
		}
		return {
			...entry,
			edit: isEditMode ? createEditable(type, dbId, entryEditOptions(entry)) : createNoop(),
		};
	});

	// Eagerly hydrate bylines and taxonomy terms for all entries in parallel.
	// Both are independent queries, so running them concurrently halves the
	// round-trip cost on remote databases (D1 replicas, etc.).
	await Promise.all([
		hydrateEntryBylines(type, entriesWithEdit),
		hydrateEntryTerms(type, entriesWithEdit),
	]);

	return { entries: entriesWithEdit, nextCursor, cacheHint: cacheHint ?? {} };
}

/**
 * Get a single entry by type and ID/slug
 *
 * Returns { entry, error, isPreview } for graceful error handling.
 * - entry is null if not found (not an error)
 * - error is set only for actual errors (db issues, etc.)
 *
 * Preview mode is detected automatically from request context (ALS).
 * When the URL has a valid `_preview` token, the middleware sets preview
 * context and this function serves draft revision data if available.
 *
 * @example
 * ```ts
 * import { getEmDashEntry } from "emdash";
 *
 * // Simple usage — preview just works via middleware
 * const { entry: post, isPreview, error } = await getEmDashEntry("posts", "my-slug");
 * if (!post) return Astro.redirect("/404");
 * ```
 */
export async function getEmDashEntry<T extends string, D = InferCollectionData<T>>(
	type: T,
	id: string,
	options?: { locale?: string },
): Promise<EntryResult<D>> {
	// Dynamic import to avoid build-time issues
	const { getLiveEntry } = await import("astro:content");

	// Check ALS for preview and edit mode context
	const ctx = getRequestContext();
	const preview = ctx?.preview;
	const isEditMode = ctx?.editMode ?? false;
	const isPreviewMode = !!preview && preview.collection === type;
	// Edit mode implies preview — editors should see draft content
	const serveDrafts = isPreviewMode || isEditMode;

	// Resolve locale: explicit option > ALS context > undefined (no filter)
	const requestedLocale = options?.locale ?? ctx?.locale;

	/** Wrap a raw Astro entry with edit proxy, tagging editable fields if needed */
	function wrapEntry(raw: ContentEntry<D>): ContentEntry<D> {
		const dbId = entryDatabaseId(raw);
		if (isEditMode) {
			tagEditableFields(entryData(raw), type, dbId);
		}
		return {
			...raw,
			edit: isEditMode ? createEditable(type, dbId, entryEditOptions(raw)) : createNoop(),
		};
	}

	/** Check if an entry is publicly visible (published or scheduled past its time) */
	function isVisible(entry: ContentEntry<D>): boolean {
		const data = entryData(entry);
		const status = dataStr(data, "status");
		const scheduledAt = dataStr(data, "scheduledAt") || undefined;
		const isPublished = status === "published";
		const isScheduledAndReady =
			status === "scheduled" && scheduledAt && new Date(scheduledAt) <= new Date();
		return isPublished || !!isScheduledAndReady;
	}

	// Build the fallback chain: [requestedLocale, fallback1, ..., defaultLocale]
	// When i18n is disabled or no locale requested, just use a single-element chain
	const localeChain =
		requestedLocale && isI18nEnabled() ? getFallbackChain(requestedLocale) : [requestedLocale];

	/** Return a successful EntryResult with bylines and taxonomy terms hydrated */
	async function successResult(
		wrapped: ContentEntry<D>,
		opts: { isPreview: boolean; fallbackLocale?: string; cacheHint: CacheHint },
	): Promise<EntryResult<D>> {
		await Promise.all([hydrateEntryBylines(type, [wrapped]), hydrateEntryTerms(type, [wrapped])]);
		return {
			entry: wrapped,
			isPreview: opts.isPreview,
			fallbackLocale: opts.fallbackLocale,
			cacheHint: opts.cacheHint,
		};
	}

	if (serveDrafts) {
		// Draft mode: try each locale in the fallback chain
		for (let i = 0; i < localeChain.length; i++) {
			const locale = localeChain[i];
			const fallbackLocale = i > 0 ? locale : undefined;

			const {
				entry: baseEntry,
				error: baseError,
				cacheHint,
			} = await getLiveEntry(COLLECTION_NAME, {
				type,
				id,
				locale,
			});

			if (baseError) {
				return { entry: null, error: baseError, isPreview: serveDrafts, cacheHint: {} };
			}

			if (!baseEntry) continue; // Try next locale in chain

			// Preview tokens are item-scoped: verify the resolved entry matches.
			// Edit mode (authenticated editors) has collection-wide draft access.
			if (isPreviewMode && !isEditMode) {
				const dbId = entryDatabaseId(baseEntry);
				if (preview!.id !== dbId && preview!.id !== id) {
					// Token doesn't match — serve only if publicly visible, without draft access
					if (isVisible(baseEntry)) {
						return successResult(wrapEntry(baseEntry), {
							isPreview: false,
							fallbackLocale,
							cacheHint: cacheHint ?? {},
						});
					}
					// Not visible — try next locale in fallback chain
					continue;
				}
			}

			// Check if entry has a draft revision — if so, re-fetch with revision data
			const baseData = entryData(baseEntry);
			const draftRevisionId = dataStr(baseData, "draftRevisionId") || undefined;

			if (draftRevisionId) {
				const { entry: draftEntry, error: draftError } = await getLiveEntry(COLLECTION_NAME, {
					type,
					id,
					revisionId: draftRevisionId,
					locale,
				});

				if (!draftError && draftEntry) {
					return successResult(wrapEntry(draftEntry), {
						isPreview: serveDrafts,
						fallbackLocale,
						cacheHint: cacheHint ?? {},
					});
				}
			}

			return successResult(wrapEntry(baseEntry), {
				isPreview: serveDrafts,
				fallbackLocale,
				cacheHint: cacheHint ?? {},
			});
		}

		// No entry found in any locale
		return { entry: null, isPreview: serveDrafts, cacheHint: {} };
	}

	// Normal mode: try each locale in the fallback chain, only return published content
	for (let i = 0; i < localeChain.length; i++) {
		const locale = localeChain[i];
		const fallbackLocale = i > 0 ? locale : undefined;

		const { entry, error, cacheHint } = await getLiveEntry(COLLECTION_NAME, { type, id, locale });
		if (error) {
			return { entry: null, error, isPreview: false, cacheHint: {} };
		}

		if (entry && isVisible(entry)) {
			return successResult(wrapEntry(entry), {
				isPreview: false,
				fallbackLocale,
				cacheHint: cacheHint ?? {},
			});
		}
		// Entry not found or not visible in this locale — try next
	}

	return { entry: null, isPreview: false, cacheHint: {} };
}

/**
 * Eagerly hydrate byline data onto entry.data for one or more entries.
 *
 * Attaches `bylines` (array of ContentBylineCredit) and `byline`
 * (primary BylineSummary or null) to each entry's data object.
 * Uses batch queries to avoid N+1.
 *
 * Fails silently if the byline tables don't exist yet (pre-migration).
 */
async function hydrateEntryBylines<D>(type: string, entries: ContentEntry<D>[]): Promise<void> {
	if (entries.length === 0) return;

	try {
		const { getBylinesForEntries } = await import("./bylines/index.js");

		const ids = entries.map((e) => dataStr(entryData(e), "id")).filter(Boolean);
		if (ids.length === 0) return;

		const bylinesMap = await getBylinesForEntries(type, ids);

		for (const entry of entries) {
			const data = entryData(entry);
			const dbId = dataStr(data, "id");
			if (!dbId) continue;

			const credits = bylinesMap.get(dbId) ?? [];
			data.bylines = credits;
			data.byline = credits[0]?.byline ?? null;
		}
	} catch (err) {
		// Only swallow "table not found" errors from pre-migration databases
		const msg = err instanceof Error ? err.message : "";
		if (!msg.includes("no such table")) {
			console.warn("[emdash] Failed to hydrate bylines:", msg);
		}
	}
}

/**
 * Eagerly hydrate taxonomy term data onto entry.data for one or more entries.
 *
 * Attaches `terms` (Record keyed by taxonomy name with an array of TaxonomyTerm
 * values) to each entry's data object. Uses a single batched JOIN query across
 * all taxonomies so the cost is O(1) regardless of the number of entries or
 * taxonomies on the site.
 *
 * This eliminates the common N+1 pattern where templates loop over list
 * results and call getEntryTerms() per entry. With hydration, the list page
 * stays at a single round-trip for term data.
 *
 * Fails silently if the taxonomy tables don't exist yet (pre-migration).
 */
async function hydrateEntryTerms<D>(type: string, entries: ContentEntry<D>[]): Promise<void> {
	if (entries.length === 0) return;

	try {
		const { getAllTermsForEntries } = await import("./taxonomies/index.js");

		const ids = entries.map((e) => dataStr(entryData(e), "id")).filter(Boolean);
		if (ids.length === 0) return;

		const termsMap = await getAllTermsForEntries(type, ids);

		for (const entry of entries) {
			const data = entryData(entry);
			const dbId = dataStr(data, "id");
			if (!dbId) continue;

			data.terms = termsMap.get(dbId) ?? {};
		}
	} catch (err) {
		// Only swallow "table not found" errors from pre-migration databases
		const msg = err instanceof Error ? err.message : "";
		if (!msg.includes("no such table")) {
			console.warn("[emdash] Failed to hydrate terms:", msg);
		}
	}
}

/**
 * Translation summary for a single locale variant
 */
export interface TranslationSummary {
	/** Content item ID */
	id: string;
	/** Locale code (e.g. "en", "fr") */
	locale: string;
	/** URL slug */
	slug: string | null;
	/** Current status */
	status: string;
}

/**
 * Result from getTranslations
 */
export interface TranslationsResult {
	/** The translation group ID (shared across locales) */
	translationGroup: string;
	/** All locale variants in this group */
	translations: TranslationSummary[];
	/** Error if the query failed */
	error?: Error;
}

/**
 * Get all translations of a content item.
 *
 * Given a content entry, returns all locale variants that share the same
 * translation group. This is useful for building language switcher UI.
 *
 * @example
 * ```ts
 * import { getEmDashEntry, getTranslations } from "emdash";
 *
 * const { entry: post } = await getEmDashEntry("posts", "hello-world", { locale: "en" });
 * const { translations } = await getTranslations("posts", post.data.id);
 * // translations = [{ id: "...", locale: "en", slug: "hello-world", status: "published" }, ...]
 * ```
 */
export async function getTranslations(type: string, id: string): Promise<TranslationsResult> {
	try {
		const db = (await import("./loader.js")).getDb;
		const dbInstance = await db();
		const { ContentRepository } = await import("./database/repositories/content.js");
		const repo = new ContentRepository(dbInstance);

		// Find the item to get its translation group
		const item = await repo.findByIdOrSlug(type, id);
		if (!item) {
			return {
				translationGroup: "",
				translations: [],
				error: new Error(`Content item not found: ${id}`),
			};
		}

		const group = item.translationGroup || item.id;
		const translations = await repo.findTranslations(type, group);

		return {
			translationGroup: group,
			translations: translations.map((t) => ({
				id: t.id,
				locale: t.locale || "en",
				slug: t.slug,
				status: t.status,
			})),
		};
	} catch (error) {
		return {
			translationGroup: "",
			translations: [],
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
}

/**
 * Result from resolveEmDashPath
 */
export interface ResolvePathResult<T = Record<string, unknown>> {
	/** The matched entry */
	entry: ContentEntry<T>;
	/** The collection slug that matched */
	collection: string;
	/** Extracted parameters from the URL pattern (e.g. { slug: "my-post" }) */
	params: Record<string, string>;
}

/** Matches `{paramName}` placeholders in URL patterns */
const URL_PARAM_PATTERN = /\{(\w+)\}/g;

/** Convert a URL pattern like "/blog/{slug}" to a regex and param name list */
function patternToRegex(pattern: string): { regex: RegExp; paramNames: string[] } {
	const paramNames: string[] = [];
	const regexStr = pattern.replace(URL_PARAM_PATTERN, (_match, name: string) => {
		paramNames.push(name);
		return "([^/]+)";
	});
	return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

/** Cached compiled URL patterns for resolveEmDashPath */
interface CachedPattern {
	slug: string;
	regex: RegExp;
	paramNames: string[];
}
let cachedUrlPatterns: CachedPattern[] | null = null;

/**
 * Invalidate the cached URL patterns used by resolveEmDashPath.
 * Call when collection URL patterns change (schema updates).
 */
export function invalidateUrlPatternCache(): void {
	cachedUrlPatterns = null;
}

/**
 * Resolve a URL path to a content entry by matching against collection URL patterns.
 *
 * Loads all collections with a `urlPattern` set, converts each pattern to a regex,
 * and tests the given path. On match, extracts the slug and fetches the entry.
 *
 * @example
 * ```ts
 * import { resolveEmDashPath } from "emdash";
 *
 * // Given pages with urlPattern "/{slug}" and posts with "/blog/{slug}":
 * const result = await resolveEmDashPath("/blog/hello-world");
 * if (result) {
 *   console.log(result.collection); // "posts"
 *   console.log(result.params.slug); // "hello-world"
 *   console.log(result.entry.data); // post data
 * }
 * ```
 */
export async function resolveEmDashPath<T = Record<string, unknown>>(
	path: string,
): Promise<ResolvePathResult<T> | null> {
	// Build and cache compiled patterns on first call
	if (!cachedUrlPatterns) {
		const { getDb } = await import("./loader.js");
		const { SchemaRegistry } = await import("./schema/registry.js");
		const db = await getDb();
		const registry = new SchemaRegistry(db);
		const collections = await registry.listCollections();

		cachedUrlPatterns = [];
		for (const collection of collections) {
			if (!collection.urlPattern) continue;
			const { regex, paramNames } = patternToRegex(collection.urlPattern);
			cachedUrlPatterns.push({ slug: collection.slug, regex, paramNames });
		}
	}

	for (const pattern of cachedUrlPatterns) {
		const match = path.match(pattern.regex);
		if (!match) continue;

		// Extract params
		const params: Record<string, string> = {};
		for (let i = 0; i < pattern.paramNames.length; i++) {
			params[pattern.paramNames[i]] = match[i + 1];
		}

		// Look up entry by slug (most common pattern)
		const slug = params.slug;
		if (!slug) continue;

		const { entry } = await getEmDashEntry<string, T>(pattern.slug, slug);
		if (entry) {
			return { entry, collection: pattern.slug, params };
		}
	}

	return null;
}
