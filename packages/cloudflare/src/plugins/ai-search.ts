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
 */

import type {
	ContentDeleteEvent,
	ContentHookEvent,
	ContentPublishStateChangeEvent,
	PluginContext,
	PluginDescriptor,
	ResolvedPlugin,
	RouteContext,
} from "emdash";
import { definePlugin, extractPlainText, PluginRouteError } from "emdash";

const MD_EXT = /\.md$/;
const ITEM_PREFIX = /^item:/;

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
}

/**
 * KV key holding the collections the operator last configured in the admin
 * dashboard. Persisted so the picker can restore the previous selection and
 * the content hooks know which collections to index.
 */
const CONFIG_COLLECTIONS_KEY = "config:collections";

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

interface AiSearchConfig {
	id: string;
	type?: string;
	source?: string;
	index_method?: { vector: boolean; keyword: boolean };
	custom_metadata?: Array<{ field_name: string; data_type: "text" | "number" | "boolean" }>;
	[key: string]: unknown;
}

interface AiSearchInstance {
	search(params: AiSearchSearchRequest): Promise<AiSearchSearchResponse>;
	update(config: Partial<AiSearchConfig>): Promise<unknown>;
	info(): Promise<{ id: string; [key: string]: unknown }>;
	items: {
		upload(
			name: string,
			content: string,
			options?: { metadata?: Record<string, unknown> },
		): Promise<AiSearchItemInfo>;
		delete(itemId: string): Promise<void>;
	};
}

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

function isAiSearchNamespace(value: unknown): value is AiSearchNamespace {
	return isRecord(value) && typeof value.get === "function" && typeof value.create === "function";
}

/** Get Cloudflare runtime env via cloudflare:workers. */
async function getCloudflareEnv(): Promise<object | null> {
	try {
		const { env } = await import("cloudflare:workers");
		return env;
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
	import("cloudflare:workers").then(({ waitUntil }) => waitUntil(promise)).catch(() => {});
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

interface UploadItemOptions {
	/** Called as soon as AI Search accepts the upload, before mirror bookkeeping. */
	onUploaded?: (item: AiSearchItemInfo) => Promise<void>;
	/** Leave accepted uploads in place when mirror bookkeeping fails. */
	tolerateMirrorFailure?: boolean;
}

/** Replace a mirrored item before uploading because AI Search keys are unique. */
async function uploadItem(
	instance: AiSearchInstance,
	key: string,
	markdown: string,
	metadata: Record<string, string>,
	ctx: PluginContext,
	options: UploadItemOptions = {},
): Promise<void> {
	const mirrorKey = `item:${key}`;
	const previousId = await ctx.kv.get<string>(mirrorKey);
	let previousRemoved = false;
	if (previousId) {
		try {
			await instance.items.delete(previousId);
			previousRemoved = true;
		} catch {
			// A stale mirror is harmless: upload will either succeed or surface
			// the real key conflict to the caller.
		}
	}

	let item: AiSearchItemInfo;
	try {
		item = await instance.items.upload(key, markdown, { metadata });
	} catch (error) {
		if (previousRemoved) await ctx.kv.delete(mirrorKey);
		throw error;
	}
	// AI Search's non-polling upload call returning without throwing is the
	// acceptance boundary. Reindex progress is checkpointed here; indexing may
	// continue asynchronously inside AI Search.
	await options.onUploaded?.(item);

	if (!item?.id) {
		if (options.tolerateMirrorFailure) return;
		throw new Error(`upload for ${key} returned no item id`);
	}
	try {
		await ctx.kv.set(mirrorKey, item.id);
	} catch (error) {
		if (options.tolerateMirrorFailure) {
			console.error(`[ai-search] Failed to mirror accepted upload ${key}:`, error);
			return;
		}
		// Hook-driven writes retain their stronger rollback guarantee. Reindexing
		// can reconcile an accepted-but-unmirrored upload in a later pass.
		try {
			await instance.items.delete(item.id);
		} catch {}
		if (previousRemoved) await ctx.kv.delete(mirrorKey);
		throw error;
	}
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

/**
 * Compile a synonym set into a single reusable regex. Benchmarking showed that
 * recompiling a regex per synonym per query is O(synonyms) and dominates the
 * cost (~29µs at 100 synonyms), while one combined precompiled alternation is
 * flat (~0.2µs) and still supports multi-word phrases — unlike a word-split
 * `Map`/`find` lookup. Callers cache the result so compilation happens only
 * when the synonym set changes.
 */
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

/**
 * Transparently rewrite a query by substituting configured synonym terms in
 * place, using a precompiled rewriter. Whole-word (case-insensitive)
 * occurrences of each `from` anywhere in the query are replaced with `to` —
 * e.g. with `autorag` -> `AI Search`, "what is autorag" becomes "what is AI
 * Search".
 */
export function applySynonyms(query: string, rewriter: SynonymRewriter): string {
	if (!rewriter.re) return query;
	rewriter.re.lastIndex = 0;
	return query.replace(rewriter.re, (match) => rewriter.lookup.get(match.toLowerCase()) ?? match);
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
		adminPages: [{ path: "/settings", label: "AI Search", icon: "search" }],
	};
}

// =============================================================================
// Plugin implementation (loaded at runtime via entrypoint)
// =============================================================================

export function createPlugin(config: AISearchConfig = {}): ResolvedPlugin {
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

	/** Persist the operator's collection selection from the dashboard. */
	async function saveConfiguredCollections(
		ctx: PluginContext,
		collections: string[],
	): Promise<void> {
		await ctx.kv.set(CONFIG_COLLECTIONS_KEY, collections);
	}

	/** Read the query synonyms configured in the dashboard. */
	async function getConfiguredSynonyms(ctx: PluginContext): Promise<Synonym[]> {
		const saved = await ctx.kv.get<Synonym[]>(CONFIG_SYNONYMS_KEY);
		return Array.isArray(saved) ? saved : [];
	}

	// Cache the compiled synonym regex across requests in this isolate so we only
	// recompile when the configured set actually changes (keyed by its JSON).
	let synonymCache: { key: string; rewriter: SynonymRewriter } | null = null;

	/** Read synonyms from KV and return a compiled (cached) rewriter. */
	async function getSynonymRewriter(ctx: PluginContext): Promise<SynonymRewriter> {
		const synonyms = await getConfiguredSynonyms(ctx);
		const key = JSON.stringify(synonyms);
		if (synonymCache?.key !== key) {
			synonymCache = { key, rewriter: compileSynonyms(synonyms) };
		}
		return synonymCache.rewriter;
	}

	/** Persist the operator's query synonyms from the dashboard. */
	async function saveConfiguredSynonyms(ctx: PluginContext, synonyms: Synonym[]): Promise<void> {
		await ctx.kv.set(CONFIG_SYNONYMS_KEY, synonyms);
	}

	/**
	 * Whether a content hook should act on the given collection. Content is
	 * synced only for collections the operator selected in the dashboard. When
	 * nothing has been configured yet, all collections are indexed so the
	 * plugin works out of the box until the operator narrows the selection.
	 */
	async function shouldSync(collection: string, ctx: PluginContext): Promise<boolean> {
		const configured = await getConfiguredCollections(ctx);
		return configured === null || configured.includes(collection);
	}

	async function getBinding(): Promise<AiSearchNamespace | null> {
		const env = await getCloudflareEnv();
		if (!env) return null;
		const candidate: unknown = Reflect.get(env, bindingName);
		return isAiSearchNamespace(candidate) ? candidate : null;
	}

	async function ensureInstance(ns: AiSearchNamespace): Promise<AiSearchInstance> {
		const handle = ns.get(instanceName);
		try {
			await handle.info();
			return handle;
		} catch {
			return ns.create({
				id: instanceName,
				index_method: { vector: true, keyword: hybridSearch },
				// AI Search allows at most 5 custom metadata fields, so title and
				// description are packed into a single `title_desc` field to make
				// room for `locale`.
				custom_metadata: [
					{ field_name: "visible_after", data_type: "number" },
					{ field_name: "title_desc", data_type: "text" },
					{ field_name: "slug", data_type: "text" },
					{ field_name: "image", data_type: "text" },
					{ field_name: "locale", data_type: "text" },
				],
			});
		}
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

	/** Remove a content item from the AI Search index. */
	async function removeFromIndex(
		collection: string,
		id: string,
		ctx: PluginContext,
	): Promise<void> {
		const ns = await getBinding();
		if (!ns) return;

		const key = contentKey(collection, id);
		try {
			const itemId = await ctx.kv.get<string>(`item:${key}`);
			if (!itemId) return;

			const instance = await ensureInstance(ns);
			await instance.items.delete(itemId);
			// Do not erase a replacement written by a concurrent save/reindex.
			if ((await ctx.kv.get<string>(`item:${key}`)) === itemId) {
				await ctx.kv.delete(`item:${key}`);
			}
			console.log(`[ai-search] Removed ${key} (item: ${itemId})`);
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
					await retry(() =>
						uploadItem(instance, key, markdown, metadata, ctx, {
							onUploaded: () => checkpointAcceptedUpload(key),
							tolerateMirrorFailure: true,
						}),
					);
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
			pages: [{ path: "/settings", label: "AI Search", icon: "search" }],
		},

		hooks: {
			"plugin:install": {
				handler: async (_event: unknown, ctx: PluginContext): Promise<void> => {
					const collections = (await getConfiguredCollections(ctx)) ?? ["posts", "pages"];
					await saveConfiguredCollections(ctx, collections);
					const job = createReindexJob(collections, false);
					await ctx.kv.set(REINDEX_JOB_KEY, job);
					await ctx.cron?.schedule(REINDEX_CRON_TASK, { schedule: "* * * * *" });
				},
			},

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
					if (!(await shouldSync(collection, ctx))) return;

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
					if (!(await shouldSync(collection, ctx))) return;

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
					if (!(await shouldSync(collection, ctx))) return;

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
					if (!(await shouldSync(collection, ctx))) return;

					// Restored content re-enters the index according to its restored
					// status (published/scheduled index, otherwise remove).
					return waitForSync(syncSearchIndex(content, collection, ctx));
				},
			},

			"content:afterDelete": {
				handler: async (event: ContentDeleteEvent, ctx: PluginContext): Promise<void> => {
					const { id, collection } = event;
					if (!(await shouldSync(collection, ctx))) return;

					return waitForSync(removeFromIndex(collection, id, ctx));
				},
			},
		},

		routes: {
			query: {
				public: true,
				handler: async (ctx: RouteContext): Promise<unknown> => {
					const start = Date.now();

					// Support both JSON body input and URL query params (for GET requests)
					const input = isRecord(ctx.input) ? ctx.input : undefined;
					const url = new URL(ctx.request.url);
					const params = url.searchParams;

					const ns = await getBinding();
					if (!ns) {
						console.warn("[ai-search] Query failed: binding not available");
						throw new PluginRouteError("SEARCH_UNAVAILABLE", "Search is not available", 503);
					}

					const q =
						(typeof input?.q === "string" ? input.q : undefined) ?? params.get("q") ?? undefined;
					if (!q) {
						throw PluginRouteError.badRequest("Query parameter 'q' is required");
					}

					const locale =
						(typeof input?.locale === "string" ? input.locale : undefined) ??
						params.get("locale") ??
						undefined;
					if (!locale) {
						throw PluginRouteError.badRequest("Query parameter 'locale' is required");
					}

					const limit =
						(typeof input?.limit === "number" ? input.limit : undefined) ??
						(params.has("limit") ? Number(params.get("limit")) : undefined) ??
						10;
					const collection =
						(typeof input?.collection === "string" ? input.collection : undefined) ??
						params.get("collection") ??
						undefined;

					// Transparently substitute configured synonym terms so the query
					// sent to AI Search uses the canonical wording that indexes better.
					const rewriter = await getSynonymRewriter(ctx);
					const effectiveQuery = applySynonyms(q, rewriter);

					console.log(
						`[ai-search] Query: q=${JSON.stringify(q)}${
							effectiveQuery === q ? "" : ` -> ${JSON.stringify(effectiveQuery)}`
						} limit=${limit} collection=${collection ?? "all"}`,
					);

					try {
						const instance = await ensureInstance(ns);
						const nowSeconds = Math.floor(Date.now() / 1000);

						// Run a search for a specific locale and return deduped, mapped
						// results. Extracted so the locale fallback can reuse it verbatim.
						const searchLocale = async (searchLocaleCode: string) => {
							const response = await instance.search({
								messages: [{ role: "user", content: effectiveQuery }],
								ai_search_options: {
									retrieval: {
										max_num_results: limit,
										filters: {
											visible_after: { $lte: nowSeconds },
											locale: { $eq: searchLocaleCode },
										},
										// Metadata-only retrieval is always used: results are
										// rendered from the packed title/description metadata,
										// skipping the slower full-text chunk retrieval.
										metadata_only: true,
									},
								},
							});

							let chunks = response.chunks;
							if (collection) {
								const cols = collection.split(",").map((c) => c.trim());
								chunks = chunks.filter((c) => cols.some((col) => c.item.key.startsWith(`${col}/`)));
							}

							// Deduplicate by item key, keeping the highest-scoring chunk per item
							const bestByKey = new Map<string, (typeof chunks)[number]>();
							for (const c of chunks) {
								const existing = bestByKey.get(c.item.key);
								if (!existing || c.score > existing.score) {
									bestByKey.set(c.item.key, c);
								}
							}
							const uniqueChunks = [...bestByKey.values()];

							// Resolve slug/title/description for each result. Title and
							// description are packed into the `title_desc` metadata field
							// (present in both normal and metadata-only mode); unpack it.
							// The snippet uses the full-text chunk when available, otherwise
							// the description (the only text available in metadata-only mode).
							const mapped = uniqueChunks.map((c) => {
								const parsed = parseContentKey(c.item.key);
								const md = c.item.metadata ?? {};
								const slug = typeof md.slug === "string" && md.slug ? md.slug : null;
								const packed = typeof md.title_desc === "string" ? md.title_desc : "";
								const { title: rawTitle, description: rawDescription } =
									unpackTitleDescription(packed);
								const title = rawTitle ? rawTitle : null;
								const description = rawDescription ? rawDescription : null;
								const image = typeof md.image === "string" && md.image ? md.image : null;

								const snippet = c.text && c.text.trim() ? c.text : (description ?? "");
								return {
									...parsed,
									slug,
									title,
									description,
									image,
									score: c.score,
									snippet,
								};
							});

							return { searchQuery: response.search_query, results: mapped };
						};

						let { searchQuery, results } = await searchLocale(locale);

						// Fall back to the site default locale when the requested locale
						// returns nothing, so untranslated content is still discoverable.
						if (results.length === 0 && ctx.site?.locale && locale !== ctx.site.locale) {
							({ searchQuery, results } = await searchLocale(ctx.site.locale));
						}

						const elapsed = Date.now() - start;
						console.log(
							`[ai-search] Query complete: ${results.length} results in ${elapsed}ms (rewritten: ${JSON.stringify(searchQuery)})`,
						);
						return { query: searchQuery, results };
					} catch (error) {
						const elapsed = Date.now() - start;
						console.error(`[ai-search] Query failed after ${elapsed}ms:`, error);
						throw new PluginRouteError(
							"SEARCH_UNAVAILABLE",
							"Search is temporarily unavailable",
							503,
						);
					}
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
							collections: (await getConfiguredCollections(ctx)) ?? [],
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
						await saveConfiguredCollections(ctx, collections);
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
						collections: (await getConfiguredCollections(ctx)) ?? [],
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
							parseCollections(input?.collections) ?? (await getConfiguredCollections(ctx)) ?? [];
						if (collections.length === 0) {
							throw PluginRouteError.badRequest(
								"No collections specified. Select collections in the dashboard first.",
							);
						}
						await saveConfiguredCollections(ctx, collections);
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
