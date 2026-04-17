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
import { definePlugin, extractPlainText } from "emdash";

const MD_EXT = /\.md$/;

// =============================================================================
// Configuration
// =============================================================================

export interface AISearchConfig {
	/** AI Search instance name. @default "emdash-content" */
	instanceName?: string;
	/** Binding name in wrangler.jsonc. @default "AI_SEARCH" */
	binding?: string;
	/** Collections to index. Indexes all if omitted. */
	collections?: string[];
	/** Enable hybrid search (vector + keyword). @default true */
	hybridSearch?: boolean;
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

/** Get Cloudflare runtime env via cloudflare:workers. */
async function getCloudflareEnv(): Promise<Record<string, unknown> | null> {
	try {
		const { env } = await import("cloudflare:workers");
		return env as unknown as Record<string, unknown>;
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

/** Convert a content entry to Markdown for indexing. */
function contentToMarkdown(content: Record<string, unknown>, collection: string): string {
	const parts: string[] = [];

	if (typeof content.title === "string") parts.push(`# ${content.title}`);
	parts.push(`Collection: ${collection}`);

	for (const [key, value] of Object.entries(content)) {
		if (key === "title" || key === "id" || key === "slug" || key === "status") continue;
		if (key.startsWith("_")) continue;

		if (typeof value === "string") {
			const text = extractPlainText(value);
			if (text) parts.push(text);
		} else if (Array.isArray(value)) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any, typescript-eslint(no-unsafe-type-assertion) -- Portable Text arrays are untyped; extractPlainText handles validation
			const text = extractPlainText(value as any);
			if (text) parts.push(text);
		}
	}

	return parts.join("\n\n");
}

/**
 * Get the `visible_after` timestamp for a content item.
 * Returns 0 for published content (immediately visible) or the
 * scheduled_at unix timestamp in seconds for scheduled content.
 */
function getVisibleAfter(content: Record<string, unknown>): number {
	const status = typeof content.status === "string" ? content.status : "";
	if (status === "scheduled" && content.scheduled_at) {
		const d = new Date(content.scheduled_at as string);
		if (!isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
	}
	return 0;
}

/** Deterministic document key: `{collection}/{id}.md`. */
function contentKey(collection: string, id: string): string {
	return `${collection}/${id}.md`;
}

/** Parse a content key back into collection + id. */
function parseContentKey(key: string): { collection: string; id: string } {
	const [col, ...rest] = key.split("/");
	return { collection: col ?? "", id: rest.join("/").replace(MD_EXT, "") };
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
		adminPages: [{ path: "/settings", label: "AI Search", icon: "magnifying-glass" }],
	};
}

// =============================================================================
// Plugin implementation (loaded at runtime via entrypoint)
// =============================================================================

export function createPlugin(config: AISearchConfig = {}): ResolvedPlugin {
	const instanceName = config.instanceName ?? "emdash-content";
	const bindingName = config.binding ?? "AI_SEARCH";
	const targetCollections = config.collections;
	const hybridSearch = config.hybridSearch ?? true;

	async function getBinding(): Promise<AiSearchNamespace | null> {
		const env = await getCloudflareEnv();
		if (!env?.[bindingName]) return null;
		return env[bindingName] as AiSearchNamespace;
	}

	async function ensureInstance(ns: AiSearchNamespace): Promise<AiSearchInstance> {
		const handle = ns.get(instanceName);
		try {
			await handle.info();
			return handle;
		} catch {
			return ns.create({
				id: instanceName,
				hybrid_search_enabled: hybridSearch,
				custom_metadata: [
					{ field_name: "visible_after", data_type: "number" },
					{ field_name: "published_at", data_type: "number" },
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
			const markdown = contentToMarkdown(content, collection);
			if (!markdown.trim()) return;

			const slug = typeof content.slug === "string" ? content.slug : "";
			const title = typeof content.title === "string" ? content.title : "";

			// Resolve published_at timestamp for recency boosting.
			// Hooks provide publishedAt at top level; reindex merges item + item.data.
			const pubRaw = content.publishedAt ?? content.published_at;
			const pubMs = typeof pubRaw === "string" ? new Date(pubRaw).getTime() : 0;

			const metadata: Record<string, string> = {
				visible_after: String(visibleAfter),
			};
			if (pubMs > 0) metadata.published_at = String(pubMs);

			const item = await instance.items.upload(key, markdown, { metadata });

			await ctx.kv.set(`item:${key}`, item.id);
			await ctx.kv.set(`meta:${key}`, JSON.stringify({ collection, slug, title }));
			console.log(`[ai-search] Indexed ${key} (item: ${item.id})`);
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
			await ctx.kv.delete(`item:${key}`);
			await ctx.kv.delete(`meta:${key}`);
			console.log(`[ai-search] Removed ${key} (item: ${itemId})`);
		} catch (error) {
			console.error("[ai-search] Error removing content:", error);
		}
	}

	/** Reindex the given collections. Shared by the reindex route and the install hook. */
	async function reindexCollections(
		collections: string[],
		ctx: PluginContext,
	): Promise<{ indexed: number; errors: number }> {
		const ns = await getBinding();
		if (!ns) {
			console.warn("[ai-search] Reindex: binding not available");
			return { indexed: 0, errors: 0 };
		}
		if (!ctx.content) {
			console.warn("[ai-search] Reindex: content access not available");
			return { indexed: 0, errors: 0 };
		}

		const instance = await ensureInstance(ns);
		let indexed = 0;
		let errors = 0;

		for (const collection of collections) {
			let cursor: string | undefined;
			do {
				const page = await ctx.content.list(collection, {
					limit: 50,
					cursor,
				});

				for (const item of page.items) {
					try {
						const status = typeof item.status === "string" ? item.status : "";
						if (status !== "published" && status !== "scheduled") continue;

						const record = { ...item, ...item.data };
						const markdown = contentToMarkdown(record, collection);
						if (!markdown.trim()) continue;

						const key = contentKey(collection, item.id);
						const slug = typeof item.slug === "string" ? item.slug : "";
						const title = typeof item.data.title === "string" ? item.data.title : "";
						const visibleAfter = getVisibleAfter(record);

						const pubRaw = item.publishedAt;
						const pubMs = typeof pubRaw === "string" ? new Date(pubRaw).getTime() : 0;

						const metadata: Record<string, string> = {
							visible_after: String(visibleAfter),
						};
						if (pubMs > 0) metadata.published_at = String(pubMs);

						const uploaded = await instance.items.upload(key, markdown, {
							metadata,
						});

						await ctx.kv.set(`item:${key}`, uploaded.id);
						await ctx.kv.set(`meta:${key}`, JSON.stringify({ collection, slug, title }));
						indexed++;
					} catch (error) {
						console.error(`[ai-search] Failed to index ${collection}/${item.id}:`, error);
						errors++;
					}
				}

				cursor = page.cursor;
			} while (cursor);
		}

		return { indexed, errors };
	}

	return definePlugin({
		id: "ai-search",
		version: "1.0.0",
		capabilities: ["read:content"],
		admin: {
			entry: "@emdash-cms/cloudflare/plugins/ai-search-admin",
			pages: [{ path: "/settings", label: "AI Search", icon: "magnifying-glass" }],
		},

		hooks: {
			"plugin:install": {
				handler: async (_event: unknown, ctx: PluginContext): Promise<void> => {
					const collections = targetCollections ?? ["posts", "pages"];
					console.log(`[ai-search] Plugin installed, indexing: ${collections.join(", ")}`);
					const result = await reindexCollections(collections, ctx);
					console.log(
						`[ai-search] Initial index complete: ${result.indexed} indexed, ${result.errors} errors`,
					);
				},
			},

			"content:afterSave": {
				handler: (event: ContentHookEvent, ctx: PluginContext): Promise<void> => {
					const { content, collection } = event;
					if (targetCollections && !targetCollections.includes(collection))
						return Promise.resolve();

					const status = typeof content.status === "string" ? content.status : "";

					// Index published and scheduled content. Published content is
					// visible immediately (visible_after=0). Scheduled content is
					// indexed now but filtered out at query time until its
					// scheduled_at timestamp passes. Drafts are not indexed.
					let work: Promise<void> | undefined;
					if (status === "published") {
						work = indexContent(content, collection, ctx, 0);
					} else if (status === "scheduled") {
						work = indexContent(content, collection, ctx, getVisibleAfter(content));
					}
					if (work) cfWaitUntil(work);
					return work ?? Promise.resolve();
				},
			},

			"content:afterPublish": {
				handler: (event: ContentPublishStateChangeEvent, ctx: PluginContext): Promise<void> => {
					const { content, collection } = event;
					if (targetCollections && !targetCollections.includes(collection))
						return Promise.resolve();

					const work = indexContent(content, collection, ctx);
					cfWaitUntil(work);
					return work;
				},
			},

			"content:afterUnpublish": {
				handler: (event: ContentPublishStateChangeEvent, ctx: PluginContext): Promise<void> => {
					const { content, collection } = event;
					if (targetCollections && !targetCollections.includes(collection))
						return Promise.resolve();

					const work = removeFromIndex(collection, String(content.id), ctx);
					cfWaitUntil(work);
					return work;
				},
			},

			"content:afterDelete": {
				handler: (event: ContentDeleteEvent, ctx: PluginContext): Promise<void> => {
					const { id, collection } = event;
					if (targetCollections && !targetCollections.includes(collection))
						return Promise.resolve();

					const work = removeFromIndex(collection, id, ctx);
					cfWaitUntil(work);
					return work;
				},
			},
		},

		routes: {
			query: {
				public: true,
				handler: async (ctx: RouteContext): Promise<unknown> => {
					const start = Date.now();

					// Support both JSON body input and URL query params (for GET requests)
					const input = ctx.input as Record<string, unknown> | undefined;
					const url = new URL(ctx.request.url);
					const params = url.searchParams;

					const ns = await getBinding();
					if (!ns) {
						console.warn("[ai-search] Query failed: binding not available");
						return { error: `${bindingName} binding not available`, results: [] };
					}

					const q =
						(typeof input?.q === "string" ? input.q : undefined) ?? params.get("q") ?? undefined;
					if (!q) {
						return { error: "Query parameter 'q' is required", results: [] };
					}

					const limit =
						(typeof input?.limit === "number" ? input.limit : undefined) ??
						(params.has("limit") ? Number(params.get("limit")) : undefined) ??
						10;
					const collection =
						(typeof input?.collection === "string" ? input.collection : undefined) ??
						params.get("collection") ??
						undefined;

					console.log(
						`[ai-search] Query: q=${JSON.stringify(q)} limit=${limit} collection=${collection ?? "all"}`,
					);

					try {
						const instance = await ensureInstance(ns);
						const nowSeconds = Math.floor(Date.now() / 1000);

						const response = await instance.search({
							messages: [{ role: "user", content: q }],
							ai_search_options: {
								retrieval: {
									max_num_results: limit,
									filters: {
										visible_after: { $lte: nowSeconds },
									},
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

						// Look up stored metadata (slug, title) for each result.
						// Drafts are never indexed. Published and scheduled content
						// are indexed with a `visible_after` metadata field and
						// filtered at query time via `visible_after <= now`.
						const results = await Promise.all(
							uniqueChunks.map(async (c) => {
								const parsed = parseContentKey(c.item.key);
								let slug: string | null = null;
								let title: string | null = null;
								try {
									const raw = await ctx.kv.get<string>(`meta:${c.item.key}`);
									if (raw) {
										const meta = JSON.parse(raw) as { slug?: string; title?: string };
										slug = meta.slug || null;
										title = meta.title || null;
									}
								} catch {
									// KV lookup failed, fall back to parsed key
								}
								return {
									...parsed,
									slug,
									title,
									score: c.score,
									snippet: c.text,
								};
							}),
						);

						const elapsed = Date.now() - start;
						console.log(
							`[ai-search] Query complete: ${results.length} results in ${elapsed}ms (rewritten: ${JSON.stringify(response.search_query)})`,
						);
						return { query: response.search_query, results };
					} catch (error) {
						const elapsed = Date.now() - start;
						console.error(`[ai-search] Query failed after ${elapsed}ms:`, error);
						return {
							error: error instanceof Error ? error.message : "Search failed",
							results: [],
						};
					}
				},
			},

			reindex: {
				handler: async (ctx: RouteContext): Promise<unknown> => {
					const start = Date.now();

					if (!ctx.content) {
						return { error: "Content access not available" };
					}

					const input = ctx.input as Record<string, unknown> | undefined;
					const requestedCollections =
						typeof input?.collections === "string"
							? input.collections.split(",").map((c: string) => c.trim())
							: Array.isArray(input?.collections)
								? (input.collections as string[])
								: undefined;
					const collections = targetCollections ?? requestedCollections ?? [];

					if (collections.length === 0) {
						return {
							error: "No collections specified. Pass collections in the request or plugin config.",
						};
					}

					try {
						console.log(`[ai-search] Reindex started for collections: ${collections.join(", ")}`);
						const result = await reindexCollections(collections, ctx);
						const elapsed = Date.now() - start;
						console.log(
							`[ai-search] Reindex complete: ${result.indexed} indexed, ${result.errors} errors in ${elapsed}ms`,
						);
						return { ...result, collections };
					} catch (error) {
						const elapsed = Date.now() - start;
						console.error(`[ai-search] Reindex failed after ${elapsed}ms:`, error);
						return {
							error: error instanceof Error ? error.message : "Reindex failed",
						};
					}
				},
			},
		},
	});
}

export default createPlugin;
