/**
 * AI Search Plugin
 *
 * Semantic search using Cloudflare AI Search namespace bindings.
 * Indexes content on save, removes on delete, exposes a search route.
 *
 * Requires only the `ai_search_namespaces` binding in wrangler.jsonc —
 * no API tokens, no account IDs, no manual instance creation.
 *
 * @example
 * ```typescript
 * // astro.config.mjs
 * import { aiSearch } from "@emdash-cms/cloudflare/plugins";
 *
 * export default defineConfig({
 *   integrations: [
 *     emdash({
 *       plugins: [aiSearch()],
 *     }),
 *   ],
 * });
 * ```
 *
 * @example
 * ```jsonc
 * // wrangler.jsonc
 * {
 *   "ai_search_namespaces": [
 *     { "binding": "AI_SEARCH", "namespace": "default" }
 *   ]
 * }
 * ```
 *
 * @example
 * ```typescript
 * // src/pages/api/ai-search/search.ts
 * export { POST, prerender } from "@emdash-cms/cloudflare/plugins/ai-search";
 * ```
 */

import type { APIRoute } from "astro";
import type {
	ContentDeleteEvent,
	ContentHookEvent,
	ContentPublishStateChangeEvent,
	KVAccess,
	PluginContext,
	PluginDescriptor,
	ResolvedPlugin,
	RouteContext,
} from "emdash";
import {
	definePlugin,
	extractPlainText,
	getI18nConfig,
	OptionsRepository,
	PluginRouteError,
} from "emdash";
import type { EmDashRuntime } from "emdash/middleware";

const MD_EXT = /\.md$/;
const ITEM_PREFIX = /^item:/;
const INSTANCE_NOT_FOUND_MESSAGE = /ai_search_not_found|instance.*not found|not found.*instance/i;

// =============================================================================
// Configuration
// =============================================================================

export interface AISearchConfig {
	/** AI Search instance name. @default "emdash-content" */
	instanceName?: string;
	/** Binding name in wrangler.jsonc. @default "AI_SEARCH" */
	binding?: string;
	/** Enable hybrid search (vector + keyword). @default true */
	hybridSearch?: boolean;
	/** Public URL templates keyed by collection slug. @default "/{collection}/{slug}" */
	urlTemplates?: Record<string, string>;
}

const ACTIVE_CONFIG_KEY = Symbol.for("emdash.ai-search.config");

function activeConfigHolder(): { value: AISearchConfig } {
	const globals = globalThis as typeof globalThis & {
		[ACTIVE_CONFIG_KEY]?: { value: AISearchConfig };
	};
	return (globals[ACTIVE_CONFIG_KEY] ??= { value: {} });
}

export function getActiveAISearchConfig(): AISearchConfig {
	return activeConfigHolder().value;
}

/**
 * KV key holding the collections the operator last configured in the admin
 * dashboard. Persisted so the picker can restore the previous selection and
 * the content hooks know which collections to index.
 */
const CONFIG_COLLECTIONS_KEY = "config:collections";
const DEFAULT_COLLECTIONS = ["posts", "pages"];

/** KV prefix of the id-map mirrors (`item:{collection}/{id}.md` -> item id). */
const MIRROR_PREFIX = "item:";
/** Parallel deletions when purging mirrors of deselected collections. */
const PURGE_CONCURRENCY = 4;

/**
 * KV key holding query synonyms configured in the admin dashboard. Each entry
 * maps a term/phrase (`from`) to a replacement (`to`) that is substituted into
 * search queries before they reach AI Search, to improve recall.
 */
const CONFIG_SYNONYMS_KEY = "config:synonyms";

const REINDEX_JOB_KEY = "reindex:job";
const REINDEX_CRON_TASK = "reindex";
const REINDEX_PAGE_SIZE = 50;
const REINDEX_PAGES_PER_TICK = 2;
const REINDEX_HOOK_TIMEOUT_MS = 300_000;

type ReindexJobStatus = "running" | "complete";

interface ReindexJob {
	id: string;
	status: ReindexJobStatus;
	collections: string[];
	collectionIndex: number;
	cursor?: string;
	onlyMissing: boolean;
	indexed: number;
	errors: number;
	skipped: number;
	/** Item keys accepted on the current page, used to resume mid-page safely. */
	completedItemKeys?: string[];
	updatedAt: string;
}

/** AI Search's maximum length for a text custom-metadata value. */
const METADATA_TEXT_MAX_LENGTH = 500;

/** Preferred maximum length of the indexed article-preview description. */
const DESCRIPTION_MAX_LENGTH = 400;

/**
 * Separator used to pack `title` and `description` into a single metadata
 * field (AI Search allows at most 5 custom_metadata fields). The ASCII Unit
 * Separator (U+001F) is chosen because it never appears in extracted plain
 * text, so it can't collide with title or description content.
 */
const TITLE_DESC_SEP = "\u001F";

/** Pack a title and description into one value within AI Search's text limit. */
export function packTitleDescription(title: string, description: string): string {
	if ((title + TITLE_DESC_SEP + description).length <= METADATA_TEXT_MAX_LENGTH) {
		return title + TITLE_DESC_SEP + description;
	}

	// Real titles fit comfortably inside the limit; retain one character for the
	// separator if an unexpectedly long title does not.
	const packedTitle = title.slice(0, METADATA_TEXT_MAX_LENGTH - TITLE_DESC_SEP.length);
	const descriptionBudget = METADATA_TEXT_MAX_LENGTH - packedTitle.length - TITLE_DESC_SEP.length;
	return packedTitle + TITLE_DESC_SEP + truncateDescription(description, descriptionBudget);
}

/** Unpack a packed `title_desc` value, splitting on the first separator only. */
export function unpackTitleDescription(value: string): { title: string; description: string } {
	const i = value.indexOf(TITLE_DESC_SEP);
	if (i < 0) return { title: value, description: "" };
	return { title: value.slice(0, i), description: value.slice(i + 1) };
}

/** A single query synonym: replace `from` with `to` in incoming queries. */
export interface Synonym {
	from: string;
	to: string;
}

// =============================================================================
// Minimal types for the AI Search namespace binding
//
// These mirror the generated types from `wrangler types` (see
// worker-configuration.d.ts). Remove once @cloudflare/workers-types
// ships the AI Search binding types.
// =============================================================================

interface AiSearchSearchRequest {
	messages: Array<{ role: string; content: string | null }>;
	ai_search_options?: {
		retrieval?: {
			retrieval_type?: "vector" | "keyword" | "hybrid";
			match_threshold?: number;
			max_num_results?: number;
			filters?: Record<string, unknown>;
			context_expansion?: number;
			/** Return only item metadata, skipping the (slow) full-text chunks. */
			metadata_only?: boolean;
		};
		query_rewrite?: { enabled?: boolean; model?: string; rewrite_prompt?: string };
		reranking?: { enabled?: boolean; model?: string; match_threshold?: number };
	};
}

interface AiSearchSearchResponse {
	search_query: string;
	chunks: Array<{
		id: string;
		type: string;
		score: number;
		text: string;
		item: { key: string; timestamp?: number; metadata?: Record<string, unknown> };
	}>;
}

interface AiSearchItemInfo {
	id: string;
	key: string;
	status: string;
	metadata?: Record<string, unknown>;
}

interface AiSearchCustomMetadata {
	field_name: string;
	data_type: "text" | "number" | "boolean" | "datetime";
}

interface AiSearchConfig {
	id: string;
	type?: string;
	source?: string;
	index_method?: { vector: boolean; keyword: boolean };
	custom_metadata?: AiSearchCustomMetadata[];
	[key: string]: unknown;
}

interface AiSearchInstanceInfo {
	id: string;
	custom_metadata?: AiSearchCustomMetadata[];
	[key: string]: unknown;
}

interface AiSearchInstance {
	search(params: AiSearchSearchRequest): Promise<AiSearchSearchResponse>;
	update(config: Partial<AiSearchConfig>): Promise<unknown>;
	info(): Promise<AiSearchInstanceInfo>;
	items: {
		upload(
			name: string,
			content: string,
			options?: { metadata?: Record<string, unknown> },
		): Promise<AiSearchItemInfo>;
		delete(itemId: string): Promise<void>;
	};
}

const REQUIRED_CUSTOM_METADATA: AiSearchCustomMetadata[] = [
	{ field_name: "visible_after", data_type: "number" },
	{ field_name: "title_desc", data_type: "text" },
	{ field_name: "slug", data_type: "text" },
	{ field_name: "image", data_type: "text" },
	{ field_name: "locale", data_type: "text" },
];

interface AiSearchNamespace {
	get(name: string): AiSearchInstance;
	create(config: AiSearchConfig): Promise<AiSearchInstance>;
}

// =============================================================================
// Helpers
// =============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingAISearchInstanceError(error: unknown): boolean {
	if (isRecord(error) && (error.status === 404 || error.code === "NOT_FOUND")) return true;
	return error instanceof Error && INSTANCE_NOT_FOUND_MESSAGE.test(error.message);
}

function isAiSearchNamespace(value: unknown): value is AiSearchNamespace {
	return isRecord(value) && typeof value.get === "function" && typeof value.create === "function";
}

const WORKERS_MODULE_KEY = Symbol.for("emdash.ai-search.workers-module");

type WorkersModule = typeof import("cloudflare:workers");

/**
 * Import `cloudflare:workers` once per isolate. Several call sites need it, and
 * a rejected import is not cached so a later call can retry.
 */
function loadWorkersModule(): Promise<WorkersModule> {
	const globals = globalThis as typeof globalThis & {
		[WORKERS_MODULE_KEY]?: Promise<WorkersModule>;
	};
	return (globals[WORKERS_MODULE_KEY] ??= import("cloudflare:workers").catch((error: unknown) => {
		delete globals[WORKERS_MODULE_KEY];
		throw error;
	}));
}

/** Get Cloudflare runtime env via cloudflare:workers. */
async function getCloudflareEnv(): Promise<object | null> {
	try {
		return (await loadWorkersModule()).env;
	} catch {
		return null;
	}
}

/**
 * Keep the Worker isolate alive for the given promise.
 * Uses cloudflare:workers waitUntil — safe to call after the response is sent.
 * Silently no-ops outside Workers (e.g. during local dev).
 */
function cfWaitUntil(promise: Promise<unknown>): void {
	loadWorkersModule()
		.then(({ waitUntil }) => waitUntil(promise))
		.catch(() => {});
}

const SYSTEM_CONTENT_KEYS = new Set([
	"id",
	"slug",
	"status",
	"authorId",
	"author_id",
	"primaryBylineId",
	"primary_byline_id",
	"createdAt",
	"created_at",
	"updatedAt",
	"updated_at",
	"publishedAt",
	"published_at",
	"scheduledAt",
	"scheduled_at",
	"deletedAt",
	"deleted_at",
	"version",
	"liveRevisionId",
	"live_revision_id",
	"draftRevisionId",
	"draft_revision_id",
	"locale",
	"translationGroup",
	"translation_group",
]);

function isSystemContentKey(key: string): boolean {
	return key.startsWith("_") || SYSTEM_CONTENT_KEYS.has(key);
}

function extractIndexableText(value: unknown): string {
	if (typeof value === "string") return extractPlainText(value);
	if (Array.isArray(value)) return extractPlainText(JSON.stringify(value));
	return "";
}

function truncateDescription(value: string, maxLength: number = DESCRIPTION_MAX_LENGTH): string {
	if (maxLength <= 0) return "";
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	if (maxLength === 1) return "\u2026";

	const truncated = normalized.slice(0, maxLength - 1);
	const lastSpace = truncated.lastIndexOf(" ");
	return `${lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated}\u2026`;
}

/** Convert a content entry to Markdown for indexing. */
function contentToMarkdown(content: Record<string, unknown>, collection: string): string {
	const parts: string[] = [];

	if (typeof content.title === "string") parts.push(`# ${content.title}`);
	parts.push(`Collection: ${collection}`);

	for (const [key, value] of Object.entries(content)) {
		if (key === "title" || isSystemContentKey(key)) continue;
		const text = extractIndexableText(value);
		if (text) parts.push(text);
	}

	return parts.join("\n\n");
}

/**
 * Build a short plain-text description (article preview) from the content's
 * explicit excerpt. Returns an empty description when no excerpt is present.
 */
function contentToDescription(content: Record<string, unknown>): string {
	const excerpt = extractIndexableText(content.excerpt);
	return excerpt ? truncateDescription(excerpt) : "";
}

function imageUrlFromValue(value: unknown): string {
	if (!isRecord(value)) return "";
	if (typeof value.src === "string" && value.src) return value.src;
	const meta = isRecord(value.meta) ? value.meta : undefined;
	if (typeof meta?.storageKey === "string" && meta.storageKey) {
		return `/_emdash/api/media/file/${meta.storageKey}`;
	}
	return "";
}

/**
 * Extract a thumbnail URL from a content entry, preferring the conventional
 * featured-image field before falling back to the first image-shaped value.
 */
function extractImageUrl(content: Record<string, unknown>): string {
	const featured = imageUrlFromValue(content.featured_image ?? content.featuredImage);
	if (featured) return featured;

	for (const [key, value] of Object.entries(content)) {
		if (key.startsWith("_") || key === "featured_image" || key === "featuredImage") continue;
		const image = imageUrlFromValue(value);
		if (image) return image;
	}
	return "";
}

/**
 * Get the `visible_after` timestamp for a content item.
 * Returns 0 for published content (immediately visible) or the
 * scheduled_at unix timestamp in seconds for scheduled content.
 */
function getVisibleAfter(content: Record<string, unknown>): number {
	const status = typeof content.status === "string" ? content.status : "";
	// Hook events expose the camelCase `scheduledAt`; reindex merges the raw
	// row which may still carry snake_case `scheduled_at`. Accept either.
	const scheduledAt = content.scheduledAt ?? content.scheduled_at;
	if (
		status === "scheduled" &&
		(typeof scheduledAt === "string" || typeof scheduledAt === "number")
	) {
		const d = new Date(scheduledAt);
		if (!isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
	}
	return 0;
}

/**
 * Flatten a content-hook record. Content hooks pass the `ContentItem` shape,
 * where the editable fields (title, body, images) live under `.data` while the
 * system columns (id, slug, status, locale, scheduledAt) sit at the top level.
 * Merging `.data` up gives the same flat record the reindex path builds with
 * `{ ...item, ...item.data }`, so field extraction behaves identically in both
 * paths (without it, the hook path reads an empty title and skips the body).
 */
export function flattenContentRecord(content: Record<string, unknown>): Record<string, unknown> {
	const data = content.data && typeof content.data === "object" ? content.data : {};
	return { ...content, ...data };
}

/** Deterministic document key: `{collection}/{id}.md`. */
function contentKey(collection: string, id: string): string {
	return `${collection}/${id}.md`;
}

async function retry<T>(operation: () => Promise<T>): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await operation();
		} catch (error) {
			lastError = error;
			if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
		}
	}
	throw lastError;
}

/** Upload an item and mirror its AI Search item ID for later deletion. */
async function uploadItem(
	instance: AiSearchInstance,
	key: string,
	markdown: string,
	metadata: Record<string, string>,
	ctx: PluginContext,
): Promise<void> {
	const mirrorKey = `item:${key}`;
	const item = await instance.items.upload(key, markdown, { metadata });

	await ctx.kv.set(mirrorKey, item.id);
}

function createReindexJob(collections: string[], onlyMissing: boolean): ReindexJob {
	return {
		id: crypto.randomUUID(),
		status: "running",
		collections,
		collectionIndex: 0,
		onlyMissing,
		indexed: 0,
		errors: 0,
		skipped: 0,
		updatedAt: new Date().toISOString(),
	};
}

function reindexResult(job: ReindexJob) {
	return {
		jobId: job.id,
		status: job.status,
		done: job.status === "complete",
		onlyMissing: job.onlyMissing,
		collections: job.collections,
		indexed: job.indexed,
		errors: job.errors,
		skipped: job.skipped,
	};
}

/** Parse a content key back into collection + id. */
function parseContentKey(key: string): { collection: string; id: string } {
	const [col, ...rest] = key.split("/");
	return { collection: col ?? "", id: rest.join("/").replace(MD_EXT, "") };
}

/**
 * Normalize a `collections` request field into a trimmed slug array.
 * Accepts a comma-separated string or an array of strings; returns `null`
 * when the input is neither (so callers can fall back or error).
 */
function parseCollections(value: unknown): string[] | null {
	const raw =
		typeof value === "string"
			? value.split(",")
			: Array.isArray(value)
				? value.filter((v): v is string => typeof v === "string")
				: null;
	if (raw === null) return null;
	return raw.map((c) => c.trim()).filter(Boolean);
}

function hasRequiredMetadataSchema(config: AiSearchInstanceInfo): boolean {
	const actual = config.custom_metadata;
	if (!actual || actual.length !== REQUIRED_CUSTOM_METADATA.length) return false;

	const fields = new Map(actual.map((field) => [field.field_name, field.data_type]));
	return REQUIRED_CUSTOM_METADATA.every(
		(field) => fields.get(field.field_name) === field.data_type,
	);
}

/**
 * Normalize a `synonyms` request field into a validated `Synonym[]`. Accepts an
 * array of `{ from, to }` objects; trims whitespace and drops entries missing
 * either side. Returns `null` when the input is not an array.
 */
function parseSynonyms(value: unknown): Synonym[] | null {
	if (!Array.isArray(value)) return null;
	const result: Synonym[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const { from, to } = entry;
		if (typeof from !== "string" || typeof to !== "string") continue;
		const trimmedFrom = from.trim();
		const trimmedTo = to.trim();
		if (!trimmedFrom || !trimmedTo) continue;
		result.push({ from: trimmedFrom, to: trimmedTo });
	}
	return result;
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A synonym rewriter compiled from a synonym set. Holds a single combined
 * regex plus the `from` -> `to` lookup so a query can be rewritten in one pass.
 */
export interface SynonymRewriter {
	re: RegExp | null;
	lookup: Map<string, string>;
}

export function compileSynonyms(synonyms: Synonym[]): SynonymRewriter {
	// Longer phrases first so multi-word terms win over their sub-words.
	const sorted = synonyms.filter((s) => s.from).toSorted((a, b) => b.from.length - a.from.length);
	const lookup = new Map<string, string>();
	for (const s of sorted) {
		const key = s.from.toLowerCase();
		if (!lookup.has(key)) lookup.set(key, s.to);
	}
	if (sorted.length === 0) return { re: null, lookup };
	const pattern = sorted.map((s) => escapeRegex(s.from)).join("|");
	return {
		re: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`, "giu"),
		lookup,
	};
}

export function applySynonyms(query: string, rewriter: SynonymRewriter): string {
	if (!rewriter.re) return query;
	rewriter.re.lastIndex = 0;
	return query.replace(rewriter.re, (match) => rewriter.lookup.get(match.toLowerCase()) ?? match);
}

const SYNONYM_CACHE_TTL_MS = 60_000;
const SYNONYM_CACHE_KEY = Symbol.for("emdash.ai-search.synonym-cache");

interface SynonymCache {
	rewriter: SynonymRewriter;
	refreshAfter: number;
	generation: number;
}

function synonymCacheHolder(): SynonymCache {
	const globals = globalThis as typeof globalThis & { [SYNONYM_CACHE_KEY]?: SynonymCache };
	return (globals[SYNONYM_CACHE_KEY] ??= {
		rewriter: compileSynonyms([]),
		refreshAfter: 0,
		generation: 0,
	});
}

async function getSynonymRewriter(kv: KVReader): Promise<SynonymRewriter> {
	const cache = synonymCacheHolder();
	const now = Date.now();
	if (now < cache.refreshAfter) return cache.rewriter;

	const generation = cache.generation;
	cache.refreshAfter = now + SYNONYM_CACHE_TTL_MS;
	const synonyms = (await kv.get<Synonym[]>(CONFIG_SYNONYMS_KEY)) ?? [];
	if (cache.generation === generation) cache.rewriter = compileSynonyms(synonyms);

	return cache.rewriter;
}

interface AISearchQueryInput {
	query: string;
	locale: string;
	maxResults?: number;
	collection?: string;
}

interface AISearchSnippetResponse {
	search_query: string;
	chunks: Array<{
		id: string;
		type: string;
		score: number;
		item: {
			key: string;
			metadata: { title: string; description: string; image?: string };
		};
	}>;
}

interface KVReader {
	get<T>(key: string): Promise<T | null>;
}

function renderResultUrl(
	config: AISearchConfig,
	result: { collection: string; id: string; slug: string },
	locale: string,
): string {
	const template = config.urlTemplates?.[result.collection] ?? "/{collection}/{slug}";
	return template
		.replaceAll("{collection}", encodeURIComponent(result.collection))
		.replaceAll("{id}", encodeURIComponent(result.id))
		.replaceAll("{slug}", encodeURIComponent(result.slug))
		.replaceAll("{locale}", encodeURIComponent(locale));
}

async function resolveBinding(config: AISearchConfig): Promise<AiSearchNamespace | null> {
	const env = await getCloudflareEnv();
	if (!env) return null;
	const candidate: unknown = Reflect.get(env, config.binding ?? "AI_SEARCH");
	return isAiSearchNamespace(candidate) ? candidate : null;
}

async function ensureAISearchInstance(
	ns: AiSearchNamespace,
	config: AISearchConfig,
): Promise<AiSearchInstance> {
	const instanceName = config.instanceName ?? "emdash-content";
	const handle = ns.get(instanceName);
	try {
		await handle.info();
		return handle;
	} catch (error) {
		if (!isMissingAISearchInstanceError(error)) throw error;
	}

	try {
		return await ns.create({
			id: instanceName,
			index_method: { vector: true, keyword: config.hybridSearch ?? true },
			custom_metadata: REQUIRED_CUSTOM_METADATA,
		});
	} catch (createError) {
		// A concurrent initializer may have won the create; the failure is only
		// fatal if the instance still is not there.
		try {
			await handle.info();
		} catch {
			throw createError;
		}
		return handle;
	}
}

export async function searchAISearch(
	config: AISearchConfig,
	input: AISearchQueryInput,
	kv: KVReader,
	defaultLocale: string,
): Promise<AISearchSnippetResponse> {
	const ns = await resolveBinding(config);
	if (!ns) {
		throw new PluginRouteError("SEARCH_UNAVAILABLE", "Search is not available", 503);
	}

	const effectiveQuery = applySynonyms(input.query, await getSynonymRewriter(kv));
	const instance = await ensureAISearchInstance(ns, config);
	const nowSeconds = Math.floor(Date.now() / 1000);
	const requestedCollections = parseCollections(input.collection) ?? [];
	const folderFilter =
		requestedCollections.length === 1
			? `${requestedCollections[0]!}/`
			: requestedCollections.length > 1
				? { $in: requestedCollections.map((collection) => `${collection}/`) }
				: undefined;

	const searchLocale = async (locale: string): Promise<AISearchSnippetResponse> => {
		const response = await instance.search({
			messages: [{ role: "user", content: effectiveQuery }],
			ai_search_options: {
				retrieval: {
					...(input.maxResults === undefined ? {} : { max_num_results: input.maxResults }),
					filters: {
						visible_after: { $lte: nowSeconds },
						locale: { $eq: locale },
						...(folderFilter === undefined ? {} : { folder: folderFilter }),
					},
					metadata_only: true,
				},
			},
		});

		const chunks =
			requestedCollections.length === 0
				? response.chunks
				: response.chunks.filter((chunk) =>
						requestedCollections.some((collection) => chunk.item.key.startsWith(`${collection}/`)),
					);
		const bestByKey = new Map<string, (typeof chunks)[number]>();
		for (const chunk of chunks) {
			const existing = bestByKey.get(chunk.item.key);
			if (!existing || chunk.score > existing.score) bestByKey.set(chunk.item.key, chunk);
		}

		return {
			search_query: response.search_query,
			chunks: Array.from(bestByKey.values(), (chunk) => {
				const parsed = parseContentKey(chunk.item.key);
				const metadata = chunk.item.metadata ?? {};
				const packed = typeof metadata.title_desc === "string" ? metadata.title_desc : "";
				const { title, description } = unpackTitleDescription(packed);
				const slug = typeof metadata.slug === "string" && metadata.slug ? metadata.slug : parsed.id;
				const image =
					typeof metadata.image === "string" && metadata.image ? metadata.image : undefined;
				return {
					id: chunk.id,
					type: chunk.type,
					score: chunk.score,
					item: {
						key: renderResultUrl(config, { ...parsed, slug }, locale),
						metadata: {
							title: title || slug,
							description,
							...(image ? { image } : {}),
						},
					},
				};
			}),
		};
	};

	let response = await searchLocale(input.locale);
	if (response.chunks.length === 0 && input.locale !== defaultLocale) {
		response = await searchLocale(defaultLocale);
	}
	return response;
}

// =============================================================================
// Descriptor (for astro.config.mjs)
// =============================================================================

export function aiSearch(config: AISearchConfig = {}): PluginDescriptor<AISearchConfig> {
	return {
		id: "ai-search",
		version: "1.0.0",
		entrypoint: "@emdash-cms/cloudflare/plugins/ai-search",
		options: config,
		capabilities: ["read:content"],
		adminEntry: "@emdash-cms/cloudflare/plugins/ai-search-admin",
		adminPages: [{ path: "/settings", label: "Cloudflare AI Search", icon: "search" }],
	};
}

// =============================================================================
// Plugin implementation (loaded at runtime via entrypoint)
// =============================================================================

export function createPlugin(config: AISearchConfig = {}): ResolvedPlugin {
	activeConfigHolder().value = config;
	const instanceName = config.instanceName ?? "emdash-content";
	const bindingName = config.binding ?? "AI_SEARCH";
	const hybridSearch = config.hybridSearch ?? true;

	/**
	 * Read the collections the operator last configured in the dashboard.
	 * Returns `null` when nothing has been configured yet (never persisted),
	 * distinct from an explicit empty selection.
	 */
	async function getConfiguredCollections(ctx: PluginContext): Promise<string[] | null> {
		const saved = await ctx.kv.get<string[]>(CONFIG_COLLECTIONS_KEY);
		return Array.isArray(saved) ? saved : null;
	}

	async function getEffectiveCollections(ctx: PluginContext): Promise<string[]> {
		return (await getConfiguredCollections(ctx)) ?? DEFAULT_COLLECTIONS;
	}

	/** Persist the operator's collection selection from the dashboard. */
	async function saveConfiguredCollections(
		ctx: PluginContext,
		collections: string[],
	): Promise<void> {
		await ctx.kv.set(CONFIG_COLLECTIONS_KEY, collections);
	}

	/**
	 * Persist the operator's collection selection and purge every mirrored
	 * document whose collection is no longer selected.
	 *
	 * The selection is stored before any deletion so concurrent content hooks
	 * stop indexing deselected collections while the purge runs. An explicit
	 * empty selection therefore removes every mirrored document.
	 */
	async function applyConfiguredCollections(
		ctx: PluginContext,
		collections: string[],
	): Promise<void> {
		await saveConfiguredCollections(ctx, collections);

		const selected = new Set(collections);
		const mirrors = await ctx.kv.list(MIRROR_PREFIX);
		const excluded = mirrors
			.map((entry) => entry.key.replace(ITEM_PREFIX, ""))
			.filter((key) => !selected.has(parseContentKey(key).collection));
		if (excluded.length === 0) return;

		let cursor = 0;
		let failures = 0;
		await Promise.all(
			Array.from({ length: Math.min(PURGE_CONCURRENCY, excluded.length) }, async () => {
				// `cursor` advances synchronously between awaits, so each worker
				// claims a distinct mirror.
				while (cursor < excluded.length) {
					const key = excluded[cursor++]!;
					try {
						const itemId = await ctx.kv.get<string>(`${MIRROR_PREFIX}${key}`);
						if (!itemId) continue;
						await deleteIndexedItem(key, itemId, ctx);
					} catch (error) {
						failures++;
						console.error(`[ai-search] Failed to remove deselected ${key}:`, error);
					}
				}
			}),
		);

		if (failures > 0) {
			throw new PluginRouteError(
				"AI_SEARCH_PURGE_FAILED",
				`Collections saved, but ${failures} deselected item(s) could not be removed from the index`,
				503,
			);
		}
	}

	/** Read the query synonyms configured in the dashboard. */
	async function getConfiguredSynonyms(ctx: PluginContext): Promise<Synonym[]> {
		const saved = await ctx.kv.get<Synonym[]>(CONFIG_SYNONYMS_KEY);
		return Array.isArray(saved) ? saved : [];
	}

	/** Persist the operator's query synonyms from the dashboard. */
	async function saveConfiguredSynonyms(ctx: PluginContext, synonyms: Synonym[]): Promise<void> {
		await ctx.kv.set(CONFIG_SYNONYMS_KEY, synonyms);
		const cache = synonymCacheHolder();
		cache.generation++;
		cache.rewriter = compileSynonyms(synonyms);
		cache.refreshAfter = Date.now() + SYNONYM_CACHE_TTL_MS;
	}

	/**
	 * Whether a content hook should act on the given collection. Content is
	 * synced only for collections the operator selected in the dashboard, or the
	 * default collections when no selection has been saved yet.
	 */
	async function shouldSync(collection: string, ctx: PluginContext): Promise<boolean> {
		return (await getEffectiveCollections(ctx)).includes(collection);
	}

	async function getBinding(): Promise<AiSearchNamespace | null> {
		return resolveBinding(config);
	}

	async function ensureInstance(ns: AiSearchNamespace): Promise<AiSearchInstance> {
		return ensureAISearchInstance(ns, config);
	}

	/**
	 * Index a content item in AI Search.
	 *
	 * @param visibleAfter Unix timestamp (seconds) when the content becomes
	 *   visible. Use 0 for already-published content. For scheduled content,
	 *   pass the `scheduled_at` timestamp so the query filter
	 *   `visible_after <= now` excludes it until the scheduled time.
	 */
	async function indexContent(
		content: Record<string, unknown>,
		collection: string,
		ctx: PluginContext,
		visibleAfter: number = 0,
	): Promise<void> {
		const ns = await getBinding();
		if (!ns) {
			console.warn("[ai-search] indexContent: binding not available");
			return;
		}

		const key = contentKey(collection, String(content.id));
		try {
			const instance = await ensureInstance(ns);
			// Hook events nest editable fields under `.data`; flatten so title/body
			// extraction matches the reindex path.
			const record = flattenContentRecord(content);
			const markdown = contentToMarkdown(record, collection);
			if (!markdown.trim()) return;

			const slug = typeof record.slug === "string" ? record.slug : "";
			const title = typeof record.title === "string" ? record.title : "";
			const description = contentToDescription(record);
			const image = extractImageUrl(record);
			const locale =
				typeof record.locale === "string" && record.locale
					? record.locale
					: (ctx.site?.locale ?? "en");

			const metadata: Record<string, string> = {
				visible_after: String(visibleAfter),
				title_desc: packTitleDescription(title, description),
				slug,
				locale,
			};
			if (image) metadata.image = image;

			await retry(() => uploadItem(instance, key, markdown, metadata, ctx));
			console.log(`[ai-search] Queued ${key}`);
		} catch (error) {
			console.error("[ai-search] Error indexing content:", error);
		}
	}

	/**
	 * Delete one mirrored document from AI Search and drop its KV mirror.
	 * Throws, so callers decide whether a failure is fatal.
	 */
	async function deleteIndexedItem(key: string, itemId: string, ctx: PluginContext): Promise<void> {
		const ns = await getBinding();
		if (!ns) return;

		const instance = await ensureInstance(ns);
		await instance.items.delete(itemId);
		// Do not erase a replacement written by a concurrent save/reindex.
		if ((await ctx.kv.get<string>(`item:${key}`)) === itemId) {
			await ctx.kv.delete(`item:${key}`);
		}
		console.log(`[ai-search] Removed ${key} (item: ${itemId})`);
	}

	/** Remove a content item from the AI Search index. */
	async function removeFromIndex(
		collection: string,
		id: string,
		ctx: PluginContext,
	): Promise<void> {
		const key = contentKey(collection, id);
		try {
			const itemId = await ctx.kv.get<string>(`item:${key}`);
			if (!itemId) return;

			await deleteIndexedItem(key, itemId, ctx);
		} catch (error) {
			console.error("[ai-search] Error removing content:", error);
		}
	}

	/**
	 * Synchronize one content item with the public search index based on its
	 * status. Published content is indexed as immediately visible, scheduled
	 * content is indexed but gated behind its `visible_after` timestamp, and
	 * anything else (draft, trashed) is removed from the index.
	 */
	function syncSearchIndex(
		content: Record<string, unknown>,
		collection: string,
		ctx: PluginContext,
	): Promise<void> {
		const status = typeof content.status === "string" ? content.status : "";
		if (status === "published") {
			return indexContent(content, collection, ctx, 0);
		}
		if (status === "scheduled") {
			return indexContent(content, collection, ctx, getVisibleAfter(content));
		}
		return removeFromIndex(collection, String(content.id), ctx);
	}

	/** Keep the worker alive until the index write settles, then surface it. */
	function waitForSync(work: Promise<void>): Promise<void> {
		cfWaitUntil(work);
		return work;
	}

	/** Process exactly one content page so every request stays bounded. */
	async function processReindexBatch(job: ReindexJob, ctx: PluginContext) {
		if (job.status === "complete") return reindexResult(job);
		if (!ctx.content) throw new Error("Content access not available");
		const ns = await getBinding();
		if (!ns) throw new Error("AI Search binding not available");
		const instance = await ensureInstance(ns);
		const collection = job.collections[job.collectionIndex];
		if (!collection) {
			job.status = "complete";
			await ctx.kv.set(REINDEX_JOB_KEY, job);
			return reindexResult(job);
		}

		const page = await ctx.content.list(collection, {
			limit: REINDEX_PAGE_SIZE,
			cursor: job.cursor,
		});
		const completedItemKeys = new Set(job.completedItemKeys ?? []);
		let checkpointWrites = Promise.resolve();

		const checkpointAcceptedUpload = async (key: string): Promise<void> => {
			job.indexed++;
			completedItemKeys.add(key);
			job.completedItemKeys = [...completedItemKeys];
			job.updatedAt = new Date().toISOString();

			// Uploads stay concurrent, while checkpoint writes are serialized so an
			// older snapshot cannot overwrite a newer completion out of order.
			const snapshot: ReindexJob = { ...job, completedItemKeys: [...completedItemKeys] };
			checkpointWrites = checkpointWrites.then(() => ctx.kv.set(REINDEX_JOB_KEY, snapshot));
			await checkpointWrites;
		};

		await Promise.all(
			page.items.map(async (item) => {
				const key = contentKey(collection, item.id);
				if (completedItemKeys.has(key)) return;
				try {
					if (item.status !== "published" && item.status !== "scheduled") return;
					if (job.onlyMissing && (await ctx.kv.get<string>(`item:${key}`))) {
						job.skipped++;
						return;
					}

					const record = { ...item, ...item.data };
					const markdown = contentToMarkdown(record, collection);
					if (!markdown.trim()) {
						job.skipped++;
						return;
					}

					const visibleAfter = getVisibleAfter(record);
					if (item.status === "scheduled" && visibleAfter === 0) {
						throw new Error("Scheduled content is missing its publication time");
					}
					const metadata: Record<string, string> = {
						visible_after: String(visibleAfter),
						title_desc: packTitleDescription(
							typeof item.data.title === "string" ? item.data.title : "",
							contentToDescription(record),
						),
						slug: typeof item.slug === "string" ? item.slug : "",
						locale:
							typeof item.locale === "string" && item.locale
								? item.locale
								: (ctx.site?.locale ?? "en"),
					};
					const image = extractImageUrl(record);
					if (image) metadata.image = image;
					await retry(() => uploadItem(instance, key, markdown, metadata, ctx));
					await checkpointAcceptedUpload(key);
				} catch (error) {
					console.error(`[ai-search] Failed to index ${collection}/${item.id}:`, error);
					job.errors++;
				}
			}),
		);
		await checkpointWrites;

		if (page.cursor) {
			job.cursor = page.cursor;
		} else {
			job.collectionIndex++;
			delete job.cursor;
			if (job.collectionIndex >= job.collections.length) job.status = "complete";
		}
		delete job.completedItemKeys;
		job.updatedAt = new Date().toISOString();
		await ctx.kv.set(REINDEX_JOB_KEY, job);
		return reindexResult(job);
	}

	return definePlugin({
		id: "ai-search",
		version: "1.0.0",
		capabilities: ["read:content"],
		admin: {
			entry: "@emdash-cms/cloudflare/plugins/ai-search-admin",
			pages: [{ path: "/settings", label: "Cloudflare AI Search", icon: "search" }],
		},

		hooks: {
			cron: {
				// The default five-second plugin hook timeout can expire while a page
				// of accepted uploads is still checkpointing. Keep the scheduled event
				// alive for the bounded two-page batch; this does not poll for indexing.
				timeout: REINDEX_HOOK_TIMEOUT_MS,
				handler: async (event, ctx): Promise<void> => {
					if (event.name !== REINDEX_CRON_TASK) return;
					const job = await ctx.kv.get<ReindexJob>(REINDEX_JOB_KEY);
					if (!job || job.status === "complete") {
						await ctx.cron?.cancel(REINDEX_CRON_TASK);
						return;
					}

					for (let page = 0; page < REINDEX_PAGES_PER_TICK; page++) {
						if ((await processReindexBatch(job, ctx)).done) break;
					}
					if (reindexResult(job).done) await ctx.cron?.cancel(REINDEX_CRON_TASK);
				},
			},

			"content:afterSave": {
				handler: async (event: ContentHookEvent, ctx: PluginContext): Promise<void> => {
					const { content, collection } = event;
					const hasPendingDraft =
						content.status === "published" &&
						typeof content.draftRevisionId === "string" &&
						content.draftRevisionId !== content.liveRevisionId;
					if (hasPendingDraft) return;
					if (
						(content.status === "published" || content.status === "scheduled") &&
						!(await shouldSync(collection, ctx))
					)
						return;

					// Sync based on the current status: published content is visible
					// immediately (visible_after=0), scheduled content is indexed but
					// gated until its scheduledAt timestamp, and drafts are removed.
					return waitForSync(syncSearchIndex(content, collection, ctx));
				},
			},

			"content:afterPublish": {
				handler: async (
					event: ContentPublishStateChangeEvent,
					ctx: PluginContext,
				): Promise<void> => {
					const { content, collection } = event;
					if (!(await shouldSync(collection, ctx))) return;

					return waitForSync(indexContent(content, collection, ctx));
				},
			},

			"content:afterUnpublish": {
				handler: async (
					event: ContentPublishStateChangeEvent,
					ctx: PluginContext,
				): Promise<void> => {
					const { content, collection } = event;

					return waitForSync(removeFromIndex(collection, String(content.id), ctx));
				},
			},

			"content:afterSchedule": {
				handler: async (
					event: ContentPublishStateChangeEvent,
					ctx: PluginContext,
				): Promise<void> => {
					const { content, collection } = event;
					if (!(await shouldSync(collection, ctx))) return;

					// Index the item with its `visible_after` gate so it stays hidden
					// from search results until the scheduled time arrives.
					return waitForSync(syncSearchIndex(content, collection, ctx));
				},
			},

			"content:afterUnschedule": {
				handler: async (
					event: ContentPublishStateChangeEvent,
					ctx: PluginContext,
				): Promise<void> => {
					const { content, collection } = event;

					// Unscheduling returns the item to a draft state — drop it from
					// the index.
					return waitForSync(removeFromIndex(collection, String(content.id), ctx));
				},
			},

			"content:afterRestore": {
				handler: async (
					event: ContentPublishStateChangeEvent,
					ctx: PluginContext,
				): Promise<void> => {
					const { content, collection } = event;
					if (
						(content.status === "published" || content.status === "scheduled") &&
						!(await shouldSync(collection, ctx))
					)
						return;

					// Restored content re-enters the index according to its restored
					// status (published/scheduled index, otherwise remove).
					return waitForSync(syncSearchIndex(content, collection, ctx));
				},
			},

			"content:afterDelete": {
				handler: async (event: ContentDeleteEvent, ctx: PluginContext): Promise<void> => {
					const { id, collection } = event;

					return waitForSync(removeFromIndex(collection, id, ctx));
				},
			},
		},

		routes: {
			metadata: {
				handler: async (ctx: RouteContext): Promise<unknown> => {
					const method = ctx.request.method.toUpperCase();
					if (method !== "GET" && method !== "POST") {
						throw new PluginRouteError("METHOD_NOT_ALLOWED", "Method not allowed", 405);
					}

					const ns = await getBinding();
					if (!ns) {
						throw new PluginRouteError(
							"AI_SEARCH_UNAVAILABLE",
							"AI Search binding is not available",
							503,
						);
					}

					if (method === "GET") {
						try {
							const info = await ns.get(instanceName).info();
							return { valid: hasRequiredMetadataSchema(info) };
						} catch (error) {
							if (isMissingAISearchInstanceError(error)) return { valid: true };
							throw new PluginRouteError(
								"AI_SEARCH_UNAVAILABLE",
								"AI Search instance information is not available",
								503,
							);
						}
					}

					const instance = await ensureInstance(ns);
					const valid = hasRequiredMetadataSchema(await instance.info());
					if (!valid) await instance.update({ custom_metadata: REQUIRED_CUSTOM_METADATA });
					return { valid: true };
				},
			},

			status: {
				handler: async (ctx: RouteContext): Promise<unknown> => {
					if (!ctx.content) {
						throw new PluginRouteError(
							"CONTENT_UNAVAILABLE",
							"Content access is not available",
							500,
						);
					}

					// Build the set of item keys currently present in the index from the
					// KV id-map (`item:{collection}/{id}.md` -> AI Search item id).
					const itemEntries = await ctx.kv.list("item:");
					const indexedKeys = new Set<string>();
					for (const entry of itemEntries) {
						const key = entry.key.replace(ITEM_PREFIX, "").replace(MD_EXT, "");
						indexedKeys.add(key);
					}

					const input = isRecord(ctx.input) ? ctx.input : undefined;
					const params = new URL(ctx.request.url).searchParams;
					const requested =
						typeof input?.collections === "string"
							? input.collections.split(",")
							: Array.isArray(input?.collections)
								? input.collections.filter((value): value is string => typeof value === "string")
								: (params.get("collections")?.split(",") ?? []);
					const trimmed = requested.map((c) => c.trim()).filter(Boolean);
					const collections =
						trimmed.length > 0 ? trimmed : ((await getConfiguredCollections(ctx)) ?? []);

					const perCollection: Array<{
						collection: string;
						eligible: number;
						indexed: number;
						missing: Array<{
							id: string;
							slug: string | null;
							title: string | null;
							status: string;
						}>;
					}> = [];

					for (const collection of collections) {
						let cursor: string | undefined;
						let eligible = 0;
						let indexed = 0;
						const missing: Array<{
							id: string;
							slug: string | null;
							title: string | null;
							status: string;
						}> = [];
						try {
							do {
								const page = await ctx.content.list(collection, { limit: 50, cursor });
								for (const item of page.items) {
									const status = typeof item.status === "string" ? item.status : "";
									if (status !== "published" && status !== "scheduled") continue;
									eligible++;
									if (indexedKeys.has(`${collection}/${item.id}`)) {
										indexed++;
									} else {
										missing.push({
											id: item.id,
											slug: item.slug,
											title: typeof item.data.title === "string" ? item.data.title : null,
											status,
										});
									}
								}
								cursor = page.cursor;
							} while (cursor);
							perCollection.push({ collection, eligible, indexed, missing });
						} catch (error) {
							console.error(`[ai-search] Status failed for ${collection}:`, error);
							perCollection.push({ collection, eligible, indexed, missing });
						}
					}

					return {
						instanceName,
						binding: bindingName,
						hybridSearch,
						totalIndexed: indexedKeys.size,
						collections: perCollection,
					};
				},
			},

			// Read or persist the operator's dashboard configuration (indexed
			// collections and query synonyms). GET returns the saved config; POST
			// updates whichever fields are provided.
			config: {
				handler: async (ctx: RouteContext): Promise<unknown> => {
					if (ctx.request.method.toUpperCase() === "GET") {
						return {
							collections: await getEffectiveCollections(ctx),
							synonyms: await getConfiguredSynonyms(ctx),
						};
					}

					const input = isRecord(ctx.input) ? ctx.input : undefined;

					if (input?.collections !== undefined) {
						const collections = parseCollections(input.collections);
						if (!collections) {
							throw PluginRouteError.badRequest(
								"collections must be an array or comma-separated list of collection slugs",
							);
						}
						await applyConfiguredCollections(ctx, collections);
					}

					if (input?.synonyms !== undefined) {
						const synonyms = parseSynonyms(input.synonyms);
						if (!synonyms) {
							throw PluginRouteError.badRequest(
								"synonyms must be an array of { from, to } objects",
							);
						}
						await saveConfiguredSynonyms(ctx, synonyms);
					}

					return {
						collections: await getEffectiveCollections(ctx),
						synonyms: await getConfiguredSynonyms(ctx),
					};
				},
			},

			reindex: {
				handler: async (ctx: RouteContext): Promise<unknown> => {
					const current = await ctx.kv.get<ReindexJob>(REINDEX_JOB_KEY);
					if (ctx.request.method.toUpperCase() === "GET") {
						return current ? reindexResult(current) : null;
					}
					if (!ctx.cron) {
						throw new PluginRouteError("CRON_UNAVAILABLE", "Cron scheduling is not available", 503);
					}

					const input = isRecord(ctx.input) ? ctx.input : undefined;
					const requestedJobId = typeof input?.jobId === "string" ? input.jobId : undefined;
					if (requestedJobId && current?.id !== requestedJobId) {
						throw PluginRouteError.notFound("Reindex job not found");
					}

					let job = current?.status === "running" ? current : null;
					if (!job) {
						const collections =
							parseCollections(input?.collections) ?? (await getEffectiveCollections(ctx));
						if (collections.length === 0) {
							throw PluginRouteError.badRequest(
								"No collections specified. Select collections in the dashboard first.",
							);
						}
						await applyConfiguredCollections(ctx, collections);
						job = createReindexJob(collections, input?.onlyMissing === true);
						await ctx.kv.set(REINDEX_JOB_KEY, job);
					}

					await ctx.cron.schedule(REINDEX_CRON_TASK, { schedule: "* * * * *" });
					return reindexResult(job);
				},
			},
		},
	});
}

export default createPlugin;

interface SnippetSearchBody {
	messages?: Array<{ role?: unknown; content?: unknown }>;
	locale?: unknown;
	collection?: unknown;
	ai_search_options?: {
		retrieval?: {
			/** Configured in the AI Search backoffice rather than controlled by public clients. */
			max_num_results?: unknown;
		};
	};
}

interface SnippetHandlerOptions {
	config: AISearchConfig;
	kv: Pick<KVAccess, "get">;
	defaultLocale: string;
}

export async function handleAISearchSnippetRequest(
	request: Request,
	options: SnippetHandlerOptions,
): Promise<Response> {
	let body: SnippetSearchBody;
	try {
		const parsed: unknown = await request.json();
		if (!isRecord(parsed)) throw new Error("Invalid request body");
		body = parsed;
	} catch {
		return Response.json({ success: false, error: "Invalid request body" }, { status: 400 });
	}

	const query = body.messages?.findLast(
		(message) => message.role === "user" && typeof message.content === "string",
	)?.content;
	if (typeof query !== "string" || !query.trim()) {
		return Response.json({ success: true, result: { search_query: "", chunks: [] } });
	}

	const locale =
		typeof body.locale === "string" && body.locale ? body.locale : options.defaultLocale;
	const collection =
		typeof body.collection === "string" && body.collection ? body.collection : undefined;
	const maxResults = body.ai_search_options?.retrieval?.max_num_results;
	if (
		maxResults !== undefined &&
		(typeof maxResults !== "number" ||
			!Number.isInteger(maxResults) ||
			maxResults < 1 ||
			maxResults > 50)
	) {
		return Response.json(
			{ success: false, error: "max_num_results must be an integer between 1 and 50" },
			{ status: 400 },
		);
	}

	try {
		const result = await searchAISearch(
			options.config,
			{ query: query.trim(), locale, maxResults, collection },
			options.kv,
			options.defaultLocale,
		);
		return Response.json({ success: true, result });
	} catch (error) {
		const status = error instanceof PluginRouteError ? error.status : 503;
		const message = status === 503 ? "Search is temporarily unavailable" : "Search failed";
		console.error("[ai-search] Snippet search failed:", error);
		return Response.json({ success: false, error: message }, { status });
	}
}

export function createAISearchSnippetEndpoint(config?: AISearchConfig): APIRoute {
	return async ({ request }) => {
		// The snippet endpoint is public: anonymous site visitors hit it for
		// site search. On the anonymous request path `locals.emdash` is the
		// partial fast-path facade whose `db` getter is undefined, so reading
		// `locals.emdash.db` throws when we load synonyms. Resolve a real,
		// request-scoped runtime via withEmDashRuntime() so `runtime.db` works
		// regardless of auth.
		//
		// Imported lazily: `emdash/middleware` references `astro:` virtual
		// modules, which the Astro config loader (plain Node ESM) cannot
		// resolve. A top-level import would drag that into config evaluation
		// via `aiSearch()` and break `astro build`.
		const { withEmDashRuntime } = await import("emdash/middleware");
		return withEmDashRuntime(async (runtime: EmDashRuntime) => {
			if (!runtime.getPluginRouteMeta("ai-search", "status")) {
				return Response.json({ success: false, error: "Search is not available" }, { status: 404 });
			}
			const options = new OptionsRepository(runtime.db);
			const prefix = "plugin:ai-search:";
			const kv: Pick<KVAccess, "get"> = {
				get: <T>(key: string) => options.get<T>(`${prefix}${key}`),
			};
			return handleAISearchSnippetRequest(request, {
				config: config ?? getActiveAISearchConfig(),
				kv,
				defaultLocale: getI18nConfig()?.defaultLocale ?? "en",
			});
		});
	};
}

export const prerender = false;
export const POST: APIRoute = createAISearchSnippetEndpoint();
