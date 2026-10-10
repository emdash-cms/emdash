import { z } from "astro/zod";
import { pluginResponse } from "emdash";

import type { Config } from "./config.js";
import { readMetadata } from "./documents.js";

/** AI Search returns at most 50 chunks; several chunks can belong to one document. */
const MAX_CHUNKS = 50;
const DEFAULT_LIMIT = 10;

/**
 * Request body sent by `<search-modal-snippet>`, plus the `locale` that the
 * Astro component adds through the snippet's `request-options`.
 */
const snippetRequestSchema = z.object({
	messages: z.array(z.object({ role: z.string(), content: z.string() })),
	locale: z.string().optional(),
	ai_search_options: z
		.object({
			retrieval: z.object({ max_num_results: z.number().optional() }).optional(),
		})
		.optional(),
});

export interface SearchInput {
	query: string;
	locale?: string;
	limit: number;
}

interface SearchHit {
	source: string;
	title: string;
	url: string;
	excerpt: string;
	image?: string;
}

export interface SearchSession {
	config: Config;
	instance: AiSearchInstance;
}

export function parseSearchRequest(body: unknown): SearchInput | null {
	const parsed = snippetRequestSchema.safeParse(body);
	if (!parsed.success) return null;
	const query = parsed.data.messages.findLast((message) => message.role === "user")?.content.trim();
	if (!query) return null;
	const requested = parsed.data.ai_search_options?.retrieval?.max_num_results ?? DEFAULT_LIMIT;
	return {
		query,
		...(parsed.data.locale ? { locale: parsed.data.locale } : {}),
		limit: Math.min(Math.max(Math.trunc(requested), 1), MAX_CHUNKS),
	};
}

/**
 * Answers the AI Search snippet's `POST {api-url}/search` in the shape of the
 * AI Search REST API.
 */
export async function searchResponse(session: SearchSession | null, body: unknown) {
	const input = parseSearchRequest(body);
	if (!input) {
		return json(400, {
			success: false,
			error: { code: "INVALID_QUERY", message: "Enter a search" },
		});
	}
	if (!session) {
		return json(503, {
			success: false,
			error: { code: "NOT_CONFIGURED", message: "Search is not set up" },
		});
	}

	const enabled = (source: string) => session.config.sources[source]?.enabled === true;
	let hits: SearchHit[];
	try {
		hits = await searchIndex(session.instance, input, enabled);
	} catch (error) {
		console.error("[ai-search] search failed:", error);
		return json(503, {
			success: false,
			error: { code: "SEARCH_UNAVAILABLE", message: "Search is temporarily unavailable" },
		});
	}
	const labels = session.config.labels ?? {};

	return json(200, {
		success: true,
		result: {
			search_query: input.query,
			chunks: hits.map((hit) => ({
				id: hit.url,
				type: "text",
				text: hit.excerpt,
				item: {
					key: hit.url,
					metadata: {
						title: escapeHtml(hit.title),
						description: escapeHtml(hit.excerpt),
						group: labels[hit.source] ?? hit.source,
						...(hit.image ? { image: hit.image } : {}),
					},
				},
			})),
		},
	});
}

/** The search box reads titles and descriptions as HTML and shows their text. */
function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function json(status: number, body: unknown) {
	return pluginResponse({
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
		body: { kind: "text", value: JSON.stringify(body) },
	});
}

export async function searchIndex(
	instance: AiSearchInstance,
	input: SearchInput,
	includeSource: (source: string) => boolean,
): Promise<SearchHit[]> {
	const response = await instance.search({
		query: input.query,
		ai_search_options: {
			retrieval: {
				max_num_results: MAX_CHUNKS,
				// Results are built from item metadata alone, so chunk text is never needed.
				metadata_only: true,
				// Throw on failure so visitors see an error rather than a misleading empty result.
				return_on_failure: false,
				...(input.locale ? { filters: { locale: input.locale } } : {}),
				boost_by: [{ field: "priority", direction: "desc" }],
			},
		},
	});
	return bestChunkPerDocument(response.chunks)
		.filter((hit) => includeSource(hit.source))
		.slice(0, input.limit);
}

/** Chunks arrive ranked, priority boost included, so a document's first chunk is its best. */
function bestChunkPerDocument(chunks: AiSearchSearchResponse["chunks"]): SearchHit[] {
	const byKey = new Map<string, SearchHit>();
	for (const chunk of chunks) {
		const metadata = byKey.has(chunk.item.key) ? null : readMetadata(chunk.item.metadata);
		if (!metadata) continue;
		const { source, title, url, excerpt, image } = metadata;
		byKey.set(chunk.item.key, { source, title, url, excerpt, ...(image ? { image } : {}) });
	}
	return [...byKey.values()];
}
