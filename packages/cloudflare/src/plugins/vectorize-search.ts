/**
 * Vectorize Search Plugin
 *
 * Semantic search using Cloudflare Vectorize and Workers AI.
 * This plugin provides a semantic search endpoint that complements
 * the core FTS5-based search.
 *
 * Usage:
 * 1. Add the plugin to your EmDash config
 * 2. Configure Vectorize index and AI bindings in wrangler.toml
 * 3. Access semantic search via plugin route
 *
 * @example
 * ```typescript
 * // astro.config.mjs
 * import emdash from "emdash/astro";
 * import { vectorizeSearch } from "@emdash-cms/cloudflare/plugins";
 *
 * export default defineConfig({
 *   integrations: [
 *     emdash({
 *       plugins: [
 *         vectorizeSearch({
 *           indexName: "emdash-content",
 *           model: "@cf/bge-base-en-v1.5",
 *         }),
 *       ],
 *     }),
 *   ],
 * });
 * ```
 *
 * @example
 * ```toml
 * # wrangler.toml
 * [[vectorize]]
 * binding = "VECTORIZE"
 * index_name = "emdash-content"
 *
 * [ai]
 * binding = "AI"
 * ```
 */

import type { PluginDefinition, PluginContext, RouteContext, ContentHookEvent } from "emdash";
import { extractPlainText } from "emdash";

/** Safely extract a string from an unknown value */
function toString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Type guard: check if value is a record-like object */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Vectorize Search Plugin Configuration
 */
export interface VectorizeSearchConfig {
	/**
	 * Name of the Vectorize index
	 * @default "emdash-content"
	 */
	indexName?: string;

	/**
	 * Workers AI embedding model to use
	 * @default "@cf/bge-base-en-v1.5"
	 */
	model?: string;

	/**
	 * Collections to index. If not specified, indexes all collections
	 * that have search enabled in their config.
	 */
	collections?: string[];
}

/**
 * Get Cloudflare runtime environment from request
 */
function getCloudflareEnv(request: Request): CloudflareEnv | null {
	// Access runtime.env from Astro's Cloudflare adapter
	// This is available when running on Cloudflare Workers
	// eslint-disable-next-line @typescript-eslint/no-explicit-any, typescript-eslint(no-unsafe-type-assertion) -- Astro locals accessed via internal symbol; no typed API available
	const locals = (request as any)[Symbol.for("astro.locals")];
	if (locals?.runtime?.env) {
		return locals.runtime.env;
	}
	return null;
}

/**
 * Extract searchable text from content entry
 */
function extractSearchableText(content: Record<string, unknown>): string {
	const parts: string[] = [];

	// Extract title if present
	if (typeof content.title === "string") {
		parts.push(content.title);
	}

	// Extract any string or Portable Text fields
	for (const [key, value] of Object.entries(content)) {
		if (key === "title" || key === "id" || key === "slug") continue;

		if (typeof value === "string") {
			// Could be plain text or JSON Portable Text
			const text = extractPlainText(value);
			if (text) parts.push(text);
		} else if (Array.isArray(value)) {
			// Assume Portable Text array
			// eslint-disable-next-line @typescript-eslint/no-explicit-any, typescript-eslint(no-unsafe-type-assertion) -- Portable Text arrays are untyped at this point; extractPlainText handles validation
			const text = extractPlainText(value as any);
			if (text) parts.push(text);
		}
	}

	return parts.join("\n");
}

/**
 * Create a Vectorize Search plugin definition
 *
 * Note: This returns a plain plugin definition object, not a resolved plugin.
 * It should be passed to the emdash() integration's plugins array.
 */
export function vectorizeSearch(config: VectorizeSearchConfig = {}): PluginDefinition {
	const model = config.model ?? "@cf/bge-base-en-v1.5";
	const targetCollections = config.collections;

	// Store env reference from routes for use in hooks
	// (hooks don't have request context directly)
	let cachedEnv: CloudflareEnv | null = null;

	return {
		id: "vectorize-search",
		version: "1.0.0",
		capabilities: ["content:read"],

		hooks: {
			/**
			 * Index content on save
			 *
			 * Note: Hooks don't have access to the request directly.
			 * We rely on the route handler being called first to cache the env,
			 * or the env being available through other means on Cloudflare.
			 */
			"content:afterSave": {
				handler: async (event: ContentHookEvent, _ctx: PluginContext): Promise<void> => {
					const { content, collection } = event;

					// Check if this collection should be indexed
					if (targetCollections && !targetCollections.includes(collection)) {
						return;
					}

					// On Cloudflare Workers, we need to get env from the execution context
					// This is a limitation - hooks don't have request context
					// The workaround is to use the query route first to cache the env
					if (!cachedEnv) {
						console.warn(
							"[vectorize-search] Environment not available in hook. " +
								"Call the /query route first to initialize, or reindex manually.",
						);
						return;
					}

					const env = cachedEnv;
					if (!env.AI || !env.VECTORIZE) {
						console.warn(
							"[vectorize-search] AI or VECTORIZE binding not available, skipping indexing",
						);
						return;
					}

					try {
						const text = extractSearchableText(content);
						if (!text.trim()) {
							return;
						}

						// Generate embedding
						const embedResult = await env.AI.run(model, {
							text: [text],
						});

						if (!embedResult?.data?.[0]) {
							console.error("[vectorize-search] Failed to generate embedding");
							return;
						}

						// Upsert to Vectorize
						const contentId = toString(content.id);
						const contentSlug = toString(content.slug);
						const contentTitle = toString(content.title);

						await env.VECTORIZE.upsert([
							{
								id: contentId,
								values: embedResult.data[0],
								metadata: {
									collection,
									slug: contentSlug ?? "",
									title: contentTitle ?? "",
								},
							},
						]);

						console.log(`[vectorize-search] Indexed ${collection}/${contentId}`);
					} catch (error) {
						console.error("[vectorize-search] Error indexing content:", error);
					}
				},
			},

			/**
			 * Remove from index on delete
			 */
			"content:afterDelete": {
				handler: async (
					event: { id: string; collection: string },
					_ctx: PluginContext,
				): Promise<void> => {
					const { id, collection } = event;

					// Check if this collection should be indexed
					if (targetCollections && !targetCollections.includes(collection)) {
						return;
					}

					if (!cachedEnv?.VECTORIZE) {
						return;
					}

					try {
						await cachedEnv.VECTORIZE.deleteByIds([id]);
						console.log(`[vectorize-search] Removed ${collection}/${id} from index`);
					} catch (error) {
						console.error("[vectorize-search] Error removing from index:", error);
					}
				},
			},
		},

		routes: {
			/**
			 * Semantic search query
			 *
			 * GET /_emdash/api/plugins/vectorize-search/query?q=hello&limit=10
			 */
			query: {
				handler: async (ctx: RouteContext): Promise<unknown> => {
					const { request } = ctx;
					const input = isRecord(ctx.input) ? ctx.input : undefined;

					// Cache env for hooks
					const env = getCloudflareEnv(request);
					if (env) {
						cachedEnv = env;
					}

					if (!env?.AI || !env?.VECTORIZE) {
						return {
							error: "Vectorize or AI binding not available",
							results: [],
						};
					}

					const query = typeof input?.q === "string" ? input.q : undefined;
					if (!query) {
						return {
							error: "Query parameter 'q' is required",
							results: [],
						};
					}

					try {
						// Generate embedding for query
						const embedResult = await env.AI.run(model, {
							text: [query],
						});

						if (!embedResult?.data?.[0]) {
							return {
								error: "Failed to generate query embedding",
								results: [],
							};
						}

						// Query Vectorize
						const limit = typeof input?.limit === "number" ? input.limit : 20;
						const queryOptions: VectorizeQueryOptions = {
							topK: limit,
							returnMetadata: "all",
						};

						// Add collection filter if specified
						const collection = typeof input?.collection === "string" ? input.collection : undefined;
						if (collection) {
							queryOptions.filter = {
								collection,
							};
						}

						const results = await env.VECTORIZE.query(embedResult.data[0], queryOptions);

						return {
							results: results.matches.map((match) => ({
								id: match.id,
								score: match.score,
								collection: toString(match.metadata?.collection),
								slug: toString(match.metadata?.slug),
								title: toString(match.metadata?.title),
							})),
						};
					} catch (error) {
						console.error("[vectorize-search] Query error:", error);
						return {
							error: error instanceof Error ? error.message : "Query failed",
							results: [],
						};
					}
				},
			},

			/**
			 * Reindex all content
			 *
			 * POST /_emdash/api/plugins/vectorize-search/reindex
			 */
			reindex: {
				handler: async (ctx: RouteContext): Promise<unknown> => {
					const { request } = ctx;

					// Cache env
					const env = getCloudflareEnv(request);
					if (env) {
						cachedEnv = env;
					}

					return { success: false, error: "REINDEX_NOT_SUPPORTED" };
				},
			},
		},

		admin: {
			pages: [
				{
					path: "/settings",
					label: "Vectorize Search",
					icon: "search",
				},
			],
		},
	};
}

// =============================================================================
// Cloudflare Types (minimal, for the plugin)
// =============================================================================

interface CloudflareEnv {
	AI?: {
		run(model: string, input: { text: string[] }): Promise<{ data: number[][] }>;
	};
	VECTORIZE?: VectorizeIndex;
}

interface VectorizeIndex {
	upsert(
		vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>,
	): Promise<void>;
	deleteByIds(ids: string[]): Promise<void>;
	query(vector: number[], options: VectorizeQueryOptions): Promise<{ matches: VectorizeMatch[] }>;
}

interface VectorizeQueryOptions {
	topK: number;
	returnMetadata?: "all" | "indexed" | "none";
	filter?: Record<string, unknown>;
}

interface VectorizeMatch {
	id: string;
	score: number;
	metadata?: Record<string, unknown>;
}

export default vectorizeSearch;
