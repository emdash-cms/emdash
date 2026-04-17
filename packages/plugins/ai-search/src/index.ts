/**
 * AI Search API Plugin
 *
 * Semantic search using the Cloudflare AI Search REST API.
 * Indexes content on save, removes on delete, exposes a search route.
 *
 * Unlike the binding-based `aiSearch()` plugin, this plugin uses the
 * Cloudflare REST API (`api.cloudflare.com`) and works on any hosting
 * platform — not just Cloudflare Workers.
 *
 * Requires a Cloudflare API token with AI Search permissions and an
 * account ID. These can be passed in the plugin config or set via
 * environment variables (`CF_ACCOUNT_ID` / `CF_API_TOKEN`).
 *
 * Uses the namespace-aware REST API endpoints at
 * `/ai-search/namespaces/{ns}/instances/{id}/...`.
 *
 * @example
 * ```typescript
 * // astro.config.mjs
 * import { aiSearchAPI } from "@emdash-cms/cloudflare/plugins";
 *
 * export default defineConfig({
 *   integrations: [
 *     emdash({
 *       plugins: [aiSearchAPI()],
 *     }),
 *   ],
 * });
 * ```
 *
 * @example
 * ```shell
 * # .env
 * CF_ACCOUNT_ID=your-account-id
 * CF_API_TOKEN=your-api-token
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

const CF_API_BASE = "https://api.cloudflare.com/client/v4/accounts";

// =============================================================================
// Configuration
// =============================================================================

export interface AISearchAPIConfig {
	/**
	 * Cloudflare account ID.
	 * Falls back to `EMDASH_CF_ACCOUNT_ID` or `CF_ACCOUNT_ID` env var.
	 */
	accountId?: string;
	/**
	 * Cloudflare API token with AI Search permissions.
	 * Falls back to `EMDASH_CF_API_TOKEN` or `CF_API_TOKEN` env var.
	 */
	apiToken?: string;
	/** AI Search namespace. @default "default" */
	namespace?: string;
	/** AI Search instance name. @default "emdash-content" */
	instanceName?: string;
	/** Collections to index. Indexes all if omitted. */
	collections?: string[];
	/** Enable hybrid search (vector + keyword). @default true */
	hybridSearch?: boolean;
}

// =============================================================================
// API response types
// =============================================================================

interface CfApiResponse<T> {
	success: boolean;
	result: T;
	errors?: Array<{ code: number; message: string }>;
}

interface AiSearchItemInfo {
	id: string;
	key: string;
	status: string;
	metadata?: Record<string, unknown>;
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

// =============================================================================
// Helpers
// =============================================================================

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
// API client
// =============================================================================

/**
 * Thin wrapper around the Cloudflare AI Search REST API.
 * Uses the namespace-aware endpoints.
 */
class AISearchClient {
	private readonly baseUrl: string;
	private readonly apiToken: string;

	constructor(accountId: string, apiToken: string, namespace: string, instanceName: string) {
		this.baseUrl = `${CF_API_BASE}/${accountId}/ai-search/namespaces/${namespace}/instances/${instanceName}`;
		this.apiToken = apiToken;
	}

	/** Build the base URL for namespace-level operations (e.g. create instance). */
	static namespaceUrl(accountId: string, namespace: string): string {
		return `${CF_API_BASE}/${accountId}/ai-search/namespaces/${namespace}/instances`;
	}

	private headers(contentType?: string): Record<string, string> {
		const h: Record<string, string> = { Authorization: `Bearer ${this.apiToken}` };
		if (contentType) h["Content-Type"] = contentType;
		return h;
	}

	/** Check whether the instance exists. */
	async instanceExists(): Promise<boolean> {
		const res = await fetch(this.baseUrl, { headers: this.headers() });
		return res.ok;
	}

	/** Create the instance. */
	async createInstance(
		accountId: string,
		namespace: string,
		config: {
			id: string;
			hybrid_search_enabled?: boolean;
			custom_metadata?: Array<{ field_name: string; data_type: string }>;
		},
	): Promise<void> {
		const url = AISearchClient.namespaceUrl(accountId, namespace);
		const res = await fetch(url, {
			method: "POST",
			headers: this.headers("application/json"),
			body: JSON.stringify(config),
		});
		if (!res.ok) {
			const body = await res.text();
			throw new Error(`Failed to create AI Search instance: ${res.status} ${body}`);
		}
	}

	/** Search the instance. */
	async search(params: {
		messages?: Array<{ role: string; content: string | null }>;
		query?: string;
		ai_search_options?: Record<string, unknown>;
	}): Promise<AiSearchSearchResponse> {
		const res = await fetch(`${this.baseUrl}/search`, {
			method: "POST",
			headers: this.headers("application/json"),
			body: JSON.stringify(params),
		});
		if (!res.ok) {
			const body = await res.text();
			throw new Error(`AI Search query failed: ${res.status} ${body}`);
		}
		const json = (await res.json()) as CfApiResponse<AiSearchSearchResponse>;
		if (!json.success) {
			throw new Error(
				`AI Search query failed: ${json.errors?.map((e) => e.message).join(", ") ?? "unknown error"}`,
			);
		}
		return json.result;
	}

	/**
	 * Upload an item to the index.
	 *
	 * Uses multipart/form-data with the content as a file attachment.
	 * The filename becomes the item key in the index.
	 */
	async uploadItem(
		key: string,
		content: string,
		metadata?: Record<string, string>,
	): Promise<AiSearchItemInfo> {
		const file = new File([content], key, { type: "text/markdown" });
		const formData = new FormData();
		formData.append("file", file);
		if (metadata) {
			formData.append("metadata", JSON.stringify(metadata));
		}

		const res = await fetch(`${this.baseUrl}/items`, {
			method: "POST",
			// No Content-Type header -- fetch sets multipart boundary automatically
			headers: { Authorization: `Bearer ${this.apiToken}` },
			body: formData,
		});
		if (!res.ok) {
			const body = await res.text();
			throw new Error(`AI Search item upload failed: ${res.status} ${body}`);
		}
		const json = (await res.json()) as CfApiResponse<AiSearchItemInfo>;
		if (!json.success) {
			throw new Error(
				`AI Search item upload failed: ${json.errors?.map((e) => e.message).join(", ") ?? "unknown error"}`,
			);
		}
		return json.result;
	}

	/** Delete an item from the index. */
	async deleteItem(itemId: string): Promise<void> {
		const res = await fetch(`${this.baseUrl}/items/${encodeURIComponent(itemId)}`, {
			method: "DELETE",
			headers: this.headers(),
		});
		if (!res.ok && res.status !== 404) {
			const body = await res.text();
			throw new Error(`AI Search item delete failed: ${res.status} ${body}`);
		}
	}
}

// =============================================================================
// Credential resolution
// =============================================================================

/** KV keys for stored credentials. */
const KV_ACCOUNT_ID = "cfg:account_id";
const KV_API_TOKEN = "cfg:api_token";

type CredentialSource = "config" | "env" | "kv" | "none";

interface ResolvedCredentials {
	accountId: string;
	apiToken: string;
	source: CredentialSource;
}

/** Resolve credentials from config or env vars (synchronous, no KV). */
function resolveCredentialsSync(config: AISearchAPIConfig): ResolvedCredentials {
	/* eslint-disable @typescript-eslint/no-unnecessary-condition */
	if (config.accountId && config.apiToken) {
		return { accountId: config.accountId, apiToken: config.apiToken, source: "config" };
	}

	const accountId =
		(typeof import.meta.env !== "undefined" &&
			(import.meta.env.EMDASH_CF_ACCOUNT_ID || import.meta.env.CF_ACCOUNT_ID)) ||
		"";
	const apiToken =
		(typeof import.meta.env !== "undefined" &&
			(import.meta.env.EMDASH_CF_API_TOKEN || import.meta.env.CF_API_TOKEN)) ||
		"";
	/* eslint-enable @typescript-eslint/no-unnecessary-condition */

	if (accountId && apiToken) {
		return { accountId, apiToken, source: "env" };
	}
	return { accountId: "", apiToken: "", source: "none" };
}

/**
 * Resolve credentials from config, KV storage, or env vars.
 *
 * Priority order:
 *   1. Plugin config (set in code — cannot be overridden)
 *   2. KV storage (set via admin UI — user explicitly saved them)
 *   3. Environment variables (fallback)
 */
async function resolveCredentials(
	config: AISearchAPIConfig,
	kv: PluginContext["kv"],
): Promise<ResolvedCredentials> {
	// 1. Plugin config (highest priority)
	if (config.accountId && config.apiToken) {
		return { accountId: config.accountId, apiToken: config.apiToken, source: "config" };
	}

	// 2. KV-stored credentials (set via admin UI)
	const kvAccountId = (await kv.get<string>(KV_ACCOUNT_ID)) ?? "";
	const kvApiToken = (await kv.get<string>(KV_API_TOKEN)) ?? "";
	if (kvAccountId && kvApiToken) {
		return { accountId: kvAccountId, apiToken: kvApiToken, source: "kv" };
	}

	// 3. Environment variables (fallback)
	const sync = resolveCredentialsSync(config);
	if (sync.source === "env") return sync;

	return { accountId: "", apiToken: "", source: "none" };
}

/**
 * Validate that credentials can reach the AI Search API.
 * Attempts to list instances in the given namespace.
 */
async function validateCredentials(
	accountId: string,
	apiToken: string,
): Promise<{ valid: boolean; error?: string }> {
	try {
		const res = await fetch(`${CF_API_BASE}/${accountId}/ai-search/instances`, {
			headers: { Authorization: `Bearer ${apiToken}` },
		});
		if (res.ok) return { valid: true };
		if (res.status === 401 || res.status === 403) {
			return { valid: false, error: "Invalid API token or insufficient permissions" };
		}
		const body = await res.text();
		return { valid: false, error: `API returned ${res.status}: ${body.slice(0, 200)}` };
	} catch (err) {
		return { valid: false, error: err instanceof Error ? err.message : "Connection failed" };
	}
}

// =============================================================================
// Descriptor (for astro.config.mjs)
// =============================================================================

export function aiSearchAPI(config: AISearchAPIConfig = {}): PluginDescriptor<AISearchAPIConfig> {
	return {
		id: "ai-search-api",
		version: "1.0.0",
		entrypoint: "@emdash-cms/plugin-ai-search",
		options: config,
		capabilities: ["read:content"],
		adminEntry: "@emdash-cms/plugin-ai-search/admin",
		adminPages: [{ path: "/settings", label: "AI Search (API)", icon: "magnifying-glass" }],
	};
}

// =============================================================================
// Plugin implementation (loaded at runtime via entrypoint)
// =============================================================================

export function createPlugin(config: AISearchAPIConfig = {}): ResolvedPlugin {
	const namespace = config.namespace ?? "default";
	const instanceName = config.instanceName ?? "emdash-content";
	const targetCollections = config.collections;
	const hybridSearch = config.hybridSearch ?? true;

	async function getClient(kv: PluginContext["kv"]): Promise<AISearchClient | null> {
		const { accountId, apiToken } = await resolveCredentials(config, kv);
		if (!accountId || !apiToken) return null;
		return new AISearchClient(accountId, apiToken, namespace, instanceName);
	}

	async function ensureInstance(client: AISearchClient, kv: PluginContext["kv"]): Promise<void> {
		const exists = await client.instanceExists();
		if (exists) return;

		const { accountId } = await resolveCredentials(config, kv);
		await client.createInstance(accountId, namespace, {
			id: instanceName,
			hybrid_search_enabled: hybridSearch,
			custom_metadata: [
				{ field_name: "visible_after", data_type: "number" },
				{ field_name: "published_at", data_type: "number" },
			],
		});
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
		const client = await getClient(ctx.kv);
		if (!client) {
			console.warn("[ai-search-api] indexContent: credentials not available");
			return;
		}

		const key = contentKey(collection, String(content.id));
		try {
			await ensureInstance(client, ctx.kv);
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

			const item = await client.uploadItem(key, markdown, metadata);

			await ctx.kv.set(`item:${key}`, item.id);
			await ctx.kv.set(`meta:${key}`, JSON.stringify({ collection, slug, title }));
			console.log(`[ai-search-api] Indexed ${key} (item: ${item.id})`);
		} catch (error) {
			console.error("[ai-search-api] Error indexing content:", error);
		}
	}

	/** Remove a content item from the AI Search index. */
	async function removeFromIndex(
		collection: string,
		id: string,
		ctx: PluginContext,
	): Promise<void> {
		const client = await getClient(ctx.kv);
		if (!client) return;

		const key = contentKey(collection, id);
		try {
			const itemId = await ctx.kv.get<string>(`item:${key}`);
			if (!itemId) return;

			await ensureInstance(client, ctx.kv);
			await client.deleteItem(itemId);
			await ctx.kv.delete(`item:${key}`);
			await ctx.kv.delete(`meta:${key}`);
			console.log(`[ai-search-api] Removed ${key} (item: ${itemId})`);
		} catch (error) {
			console.error("[ai-search-api] Error removing content:", error);
		}
	}

	/** Reindex the given collections. Shared by the reindex route and the install hook. */
	async function reindexCollections(
		collections: string[],
		ctx: PluginContext,
	): Promise<{ indexed: number; errors: number }> {
		const client = await getClient(ctx.kv);
		if (!client) {
			console.warn("[ai-search-api] Reindex: credentials not available");
			return { indexed: 0, errors: 0 };
		}
		if (!ctx.content) {
			console.warn("[ai-search-api] Reindex: content access not available");
			return { indexed: 0, errors: 0 };
		}

		await ensureInstance(client, ctx.kv);
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

						const uploaded = await client.uploadItem(key, markdown, metadata);

						await ctx.kv.set(`item:${key}`, uploaded.id);
						await ctx.kv.set(`meta:${key}`, JSON.stringify({ collection, slug, title }));
						indexed++;
					} catch (error) {
						console.error(`[ai-search-api] Failed to index ${collection}/${item.id}:`, error);
						errors++;
					}
				}

				cursor = page.cursor;
			} while (cursor);
		}

		return { indexed, errors };
	}

	return definePlugin({
		id: "ai-search-api",
		version: "1.0.0",
		capabilities: ["read:content"],
		admin: {
			entry: "@emdash-cms/plugin-ai-search/admin",
			pages: [{ path: "/settings", label: "AI Search (API)", icon: "magnifying-glass" }],
		},

		hooks: {
			"plugin:install": {
				handler: async (_event: unknown, ctx: PluginContext): Promise<void> => {
					const collections = targetCollections ?? ["posts", "pages"];
					console.log(`[ai-search-api] Plugin installed, indexing: ${collections.join(", ")}`);
					const result = await reindexCollections(collections, ctx);
					console.log(
						`[ai-search-api] Initial index complete: ${result.indexed} indexed, ${result.errors} errors`,
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
					if (status === "published") {
						return indexContent(content, collection, ctx, 0);
					} else if (status === "scheduled") {
						return indexContent(content, collection, ctx, getVisibleAfter(content));
					}
					return Promise.resolve();
				},
			},

			"content:afterPublish": {
				handler: (event: ContentPublishStateChangeEvent, ctx: PluginContext): Promise<void> => {
					const { content, collection } = event;
					if (targetCollections && !targetCollections.includes(collection))
						return Promise.resolve();

					return indexContent(content, collection, ctx);
				},
			},

			"content:afterUnpublish": {
				handler: (event: ContentPublishStateChangeEvent, ctx: PluginContext): Promise<void> => {
					const { content, collection } = event;
					if (targetCollections && !targetCollections.includes(collection))
						return Promise.resolve();

					return removeFromIndex(collection, String(content.id), ctx);
				},
			},

			"content:afterDelete": {
				handler: (event: ContentDeleteEvent, ctx: PluginContext): Promise<void> => {
					const { id, collection } = event;
					if (targetCollections && !targetCollections.includes(collection))
						return Promise.resolve();

					return removeFromIndex(collection, id, ctx);
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

					const client = await getClient(ctx.kv);
					if (!client) {
						console.warn("[ai-search-api] Query failed: credentials not available");
						return {
							error: "AI Search API credentials not configured",
							results: [],
						};
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
						`[ai-search-api] Query: q=${JSON.stringify(q)} limit=${limit} collection=${collection ?? "all"}`,
					);

					try {
						await ensureInstance(client, ctx.kv);
						const nowSeconds = Math.floor(Date.now() / 1000);

						const response = await client.search({
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
						const results = await Promise.all(
							uniqueChunks.map(async (c) => {
								const parsed = parseContentKey(c.item.key);
								let slug: string | null = null;
								let title: string | null = null;
								try {
									const raw = await ctx.kv.get<string>(`meta:${c.item.key}`);
									if (raw) {
										const meta = JSON.parse(raw) as {
											slug?: string;
											title?: string;
										};
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
							`[ai-search-api] Query complete: ${results.length} results in ${elapsed}ms (rewritten: ${JSON.stringify(response.search_query)})`,
						);
						return { query: response.search_query, results };
					} catch (error) {
						const elapsed = Date.now() - start;
						console.error(`[ai-search-api] Query failed after ${elapsed}ms:`, error);
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
						console.log(
							`[ai-search-api] Reindex started for collections: ${collections.join(", ")}`,
						);
						const result = await reindexCollections(collections, ctx);
						const elapsed = Date.now() - start;
						console.log(
							`[ai-search-api] Reindex complete: ${result.indexed} indexed, ${result.errors} errors in ${elapsed}ms`,
						);
						return { ...result, collections };
					} catch (error) {
						const elapsed = Date.now() - start;
						console.error(`[ai-search-api] Reindex failed after ${elapsed}ms:`, error);
						return {
							error: error instanceof Error ? error.message : "Reindex failed",
						};
					}
				},
			},

			/**
			 * Returns the current credential status without exposing secrets.
			 * The admin UI uses this to decide whether to show the credentials form.
			 */
			status: {
				handler: async (ctx: RouteContext): Promise<unknown> => {
					const creds = await resolveCredentials(config, ctx.kv);
					return {
						configured: creds.source !== "none",
						source: creds.source,
						// Mask the account ID — show enough to identify it
						accountId: creds.accountId
							? `${creds.accountId.slice(0, 6)}...${creds.accountId.slice(-4)}`
							: null,
						namespace,
						instanceName,
					};
				},
			},

			/**
			 * Validate and save Cloudflare credentials to plugin KV.
			 * On success, triggers a full reindex.
			 */
			credentials: {
				handler: async (ctx: RouteContext): Promise<unknown> => {
					const input = ctx.input as Record<string, unknown> | undefined;
					const accountId = typeof input?.accountId === "string" ? input.accountId.trim() : "";
					const apiToken = typeof input?.apiToken === "string" ? input.apiToken.trim() : "";

					if (!accountId || !apiToken) {
						return { error: "Both accountId and apiToken are required" };
					}

					// Validate credentials against the API
					const validation = await validateCredentials(accountId, apiToken);
					if (!validation.valid) {
						return {
							error: validation.error ?? "Invalid credentials",
							valid: false,
						};
					}

					// Save to KV
					await ctx.kv.set(KV_ACCOUNT_ID, accountId);
					await ctx.kv.set(KV_API_TOKEN, apiToken);
					console.log(`[ai-search-api] Credentials saved (account: ${accountId.slice(0, 6)}...)`);

					// Trigger reindex
					const collections = targetCollections ?? ["posts", "pages"];
					console.log(
						`[ai-search-api] Starting reindex after credential save: ${collections.join(", ")}`,
					);
					const result = await reindexCollections(collections, ctx);
					console.log(
						`[ai-search-api] Post-save reindex: ${result.indexed} indexed, ${result.errors} errors`,
					);

					return {
						valid: true,
						saved: true,
						reindex: result,
					};
				},
			},
		},
	});
}

export default createPlugin;
